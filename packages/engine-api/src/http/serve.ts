import type { EngineApiResponse, EngineApiTransport } from '../client';
import type { ProblemDetails } from '../common';
import { ENGINE_API_PREFIX } from '../constants';
import { createProblem } from '../problem';
import type { EngineApiStreamItem, RouteDefinition, RouteResponse } from '../route';
import { ENGINE_API_ROUTE_LIST } from '../routes';
import { encodeSseMessage } from '../sse';

export type EngineApiHttpHandler = (request: Request) => Promise<Response>;

interface RouteMatch {
    readonly route: RouteDefinition;
    readonly params: Readonly<Record<string, string>>;
}

/**
 * The HTTP binding of the contract over any transport, framework-agnostic so an engine can mount it on Hono, Fastify or
 * plain `fetch` handlers: every path under `ENGINE_API_PREFIX` is matched against the route table, anything else is
 * 404 problem+json. Validation and authorisation stay in the transport.
 */
export function createEngineApiHttpHandler(transport: EngineApiTransport): EngineApiHttpHandler {
    return async (request) => {
        const url = new URL(request.url);
        if (!url.pathname.startsWith(`${ENGINE_API_PREFIX}/`)) return problemResponse(createProblem('not-found'));
        const match = matchRoute(request.method, url.pathname.slice(ENGINE_API_PREFIX.length));
        if (!match) return problemResponse(createProblem('not-found'));
        return serveEngineApiRoute(transport, match.route, match.params, request);
    };
}

/**
 * Serves one operation whose route and path parameters the caller already matched: reads the query (a repeated
 * parameter is a 400), the body by the route's media type and `Last-Event-ID`, then writes the transport's answer as
 * JSON, an empty body, a `nosniff` attachment, SSE or problem+json. The request's signal ends an SSE stream.
 */
export async function serveEngineApiRoute(
    transport: EngineApiTransport,
    route: RouteDefinition,
    params: Readonly<Record<string, string>>,
    request: Request,
): Promise<Response> {
    const url = new URL(request.url);
    // No prototype, so `__proto__` and `constructor` are plain keys that reach the strict schema and fail there.
    const query = Object.create(null) as Record<string, string>;
    for (const [name, value] of url.searchParams) {
        if (Object.hasOwn(query, name)) {
            return problemResponse(
                createProblem('validation-failed', {
                    errors: [{ path: `query.${name}`, message: 'Repeated query parameter' }],
                }),
            );
        }
        query[name] = value;
    }

    const body = await readBody(route, request);
    if (body.kind === 'problem') return problemResponse(body.problem);

    const lastEventId = request.headers.get('last-event-id');
    const result = await transport(
        route,
        { params, query, body: body.value, ...(lastEventId === null ? {} : { lastEventId }) },
        request.signal,
    );
    return writeResult(route, result);
}

function matchRoute(method: string, path: string): RouteMatch | undefined {
    const segments = path.split('/').slice(1);
    let best: { match: RouteMatch; literals: number } | undefined;
    for (const route of ENGINE_API_ROUTE_LIST) {
        if (route.method !== method) continue;
        const template = route.path.split('/').slice(1);
        if (template.length !== segments.length) continue;
        const params: Record<string, string> = {};
        let literals = 0;
        let matches = true;
        for (const [index, part] of template.entries()) {
            const segment = segments[index] ?? '';
            const placeholder = /^\{(\w+)\}$/.exec(part)?.[1];
            if (placeholder === undefined) {
                if (part !== segment) {
                    matches = false;
                    break;
                }
                literals += 1;
                continue;
            }
            let decoded: string;
            try {
                decoded = decodeURIComponent(segment);
            } catch {
                matches = false;
                break;
            }
            if (decoded === '') {
                matches = false;
                break;
            }
            params[placeholder] = decoded;
        }
        // Literal segments beat placeholders, so `POST /agents/validate` is never read as an agent ID.
        if (matches && (!best || literals > best.literals)) best = { match: { route, params }, literals };
    }
    return best?.match;
}

type BodyResult =
    { readonly kind: 'ok'; readonly value: unknown } | { readonly kind: 'problem'; readonly problem: ProblemDetails };

async function readBody(route: RouteDefinition, request: Request): Promise<BodyResult> {
    switch (route.body?.kind) {
        case undefined:
            return { kind: 'ok', value: undefined };
        case 'json': {
            const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
            if (mediaType !== 'application/json') {
                return { kind: 'problem', problem: createProblem('unsupported-media-type') };
            }
            try {
                return { kind: 'ok', value: JSON.parse(await request.text()) };
            } catch {
                return {
                    kind: 'problem',
                    problem: createProblem('validation-failed', {
                        errors: [{ path: 'body', message: 'Body is not valid JSON' }],
                    }),
                };
            }
        }
        case 'multipart': {
            let form: FormData;
            try {
                form = await request.formData();
            } catch {
                return { kind: 'problem', problem: createProblem('unsupported-media-type') };
            }
            const value = Object.create(null) as Record<string, FormDataEntryValue>;
            for (const [name, entry] of form) value[name] = entry;
            return { kind: 'ok', value };
        }
    }
}

function writeResult(route: RouteDefinition, result: EngineApiResponse<unknown>): Response {
    if (result.kind === 'problem') return problemResponse(result.problem);
    const [entry] = Object.entries(route.responses);
    if (!entry) throw new Error(`Route ${route.id} declares no success response`);
    const status = Number(entry[0]);
    const success: RouteResponse = entry[1];
    switch (success.kind) {
        case 'json':
            return new Response(JSON.stringify(result.data), {
                status,
                headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
            });
        case 'empty':
            return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
        case 'binary':
            return new Response(result.data as Blob, {
                status,
                headers: {
                    'content-type': 'application/octet-stream',
                    'content-disposition': 'attachment',
                    'x-content-type-options': 'nosniff',
                    'cache-control': 'no-store',
                },
            });
        case 'sse':
            return new Response(sseBody(result.data as AsyncIterable<EngineApiStreamItem<{ readonly type: string }>>), {
                status,
                headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
            });
    }
}

function sseBody(items: AsyncIterable<EngineApiStreamItem<{ readonly type: string }>>): ReadableStream<Uint8Array> {
    const iterator = items[Symbol.asyncIterator]();
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            const next = await iterator.next();
            if (next.done) {
                controller.close();
                return;
            }
            const { id, event } = next.value;
            controller.enqueue(
                encoder.encode(
                    encodeSseMessage({
                        event: event.type,
                        data: JSON.stringify(event),
                        ...(id === null ? {} : { id }),
                    }),
                ),
            );
        },
        async cancel() {
            await iterator.return?.();
        },
    });
}

function problemResponse(problem: ProblemDetails): Response {
    return new Response(JSON.stringify(problem), {
        status: problem.status,
        headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
    });
}
