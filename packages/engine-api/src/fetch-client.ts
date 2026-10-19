import type { z } from 'zod';

import { createEngineApiClient, EngineApiContractError } from './client';
import type { EngineApiClient, EngineApiResponse, EngineApiTransport, EngineApiTransportRequest } from './client';
import { ProblemDetails } from './common';
import { ENGINE_API_PREFIX } from './constants';
import type { EngineApiStreamItem, RouteDefinition, RouteResponse, SseEventSchema, SuccessStatus } from './route';
import { parseSseStream } from './sse';

export interface FetchEngineApiClientOptions {
    /** The engine's origin, e.g. `location.origin` in the UI. */
    readonly baseUrl: string;
    readonly fetch: typeof fetch;
    /** Until the response is complete; for SSE, until the stream has started. */
    readonly timeoutMs: number;
}

/**
 * HTTP client for the UI. Same-origin credentials only: the gateway's `__Host-` session cookie authenticates every
 * call, so nothing here ever handles a token.
 */
export function createFetchEngineApiClient(options: FetchEngineApiClientOptions): EngineApiClient {
    return createEngineApiClient(createFetchTransport(options));
}

function createFetchTransport(options: FetchEngineApiClientOptions): EngineApiTransport {
    return async (route, request, signal) => {
        signal.throwIfAborted();
        const [status, success] = successResponse(route);
        const deadline = startDeadline(signal, options.timeoutMs);
        let streaming = false;
        try {
            const response = await options.fetch(requestUrl(options.baseUrl, route, request), {
                method: route.method,
                headers: requestHeaders(route, success, request),
                body: requestBody(route, request),
                credentials: 'same-origin',
                cache: 'no-store',
                // A redirect here means a proxy or a sign-in page answered instead of the API: fail loudly.
                redirect: 'error',
                signal: deadline.signal,
            });
            if (response.status === status) {
                if (success.kind === 'sse') {
                    streaming = true;
                    deadline.stopTimer();
                    return { kind: 'ok', data: decodeSse(route, success.event, response, deadline) };
                }
                return { kind: 'ok', data: await decodeSuccess(route, success, response) };
            }
            return await decodeProblem(route, response);
        } finally {
            if (!streaming) deadline.dispose();
        }
    };
}

function successResponse(route: RouteDefinition): [SuccessStatus, RouteResponse] {
    const [entry] = Object.entries(route.responses);
    if (!entry) throw new Error(`Route ${route.id} declares no success response`);
    return [Number(entry[0]) as SuccessStatus, entry[1]];
}

function requestUrl(baseUrl: string, route: RouteDefinition, request: EngineApiTransportRequest): URL {
    const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
        const value = request.params?.[name];
        if (typeof value !== 'string') throw new Error(`Route ${route.id} is missing path parameter ${name}`);
        return encodeURIComponent(value);
    });
    const url = new URL(`${ENGINE_API_PREFIX}${path}`, baseUrl);
    for (const [name, value] of Object.entries(request.query ?? {})) {
        if (value === undefined) continue;
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            throw new Error(`Route ${route.id} query parameter ${name} is not a scalar`);
        }
        url.searchParams.set(name, String(value));
    }
    return url;
}

function requestHeaders(
    route: RouteDefinition,
    success: RouteResponse,
    request: EngineApiTransportRequest,
): Record<string, string> {
    const headers: Record<string, string> = { accept: acceptFor(success) };
    if (route.body?.kind === 'json') headers['content-type'] = 'application/json';
    if (request.lastEventId !== undefined) headers['last-event-id'] = request.lastEventId;
    return headers;
}

function acceptFor(success: RouteResponse): string {
    switch (success.kind) {
        case 'json':
        case 'empty':
            return 'application/json, application/problem+json';
        case 'sse':
            return 'text/event-stream, application/problem+json';
        case 'binary':
            return '*/*';
    }
}

function requestBody(route: RouteDefinition, request: EngineApiTransportRequest): BodyInit | null {
    switch (route.body?.kind) {
        case undefined:
            return null;
        case 'json':
            return JSON.stringify(request.body);
        case 'multipart': {
            const form = new FormData();
            for (const [name, value] of Object.entries(request.body as Record<string, unknown>)) {
                if (value instanceof Blob) form.set(name, value);
                else if (typeof value === 'string') form.set(name, value);
                else throw new Error(`Route ${route.id} multipart field ${name} is neither a Blob nor a string`);
            }
            return form;
        }
    }
}

async function decodeSuccess(
    route: RouteDefinition,
    success: Exclude<RouteResponse, { kind: 'sse' }>,
    response: Response,
): Promise<unknown> {
    switch (success.kind) {
        case 'empty':
            return null;
        case 'binary':
            return await response.blob();
        case 'json':
            requireMediaType(route, response, 'application/json');
            return validate(route, success.schema, await readJson(route, response), 'response body');
    }
}

async function decodeProblem(route: RouteDefinition, response: Response): Promise<EngineApiResponse<never>> {
    requireMediaType(route, response, 'application/problem+json');
    const problem = validate(
        route,
        ProblemDetails,
        await readJson(route, response),
        `${String(response.status)} problem`,
    );
    if (problem.status !== response.status) {
        throw new EngineApiContractError(
            route.id,
            `problem status ${String(problem.status)} sent with ${String(response.status)}`,
        );
    }
    return { kind: 'problem', problem };
}

async function* decodeSse(
    route: RouteDefinition,
    schema: SseEventSchema,
    response: Response,
    deadline: Deadline,
): AsyncIterable<EngineApiStreamItem<unknown>> {
    try {
        requireMediaType(route, response, 'text/event-stream');
        if (!response.body) throw new EngineApiContractError(route.id, 'event stream without a body');
        for await (const message of parseSseStream(response.body, deadline.signal)) {
            const event = validate(route, schema, parseJson(route, message.data), 'stream event');
            if (event.type !== message.event) {
                throw new EngineApiContractError(route.id, 'SSE event name differs from the event type');
            }
            yield { id: message.id, event };
        }
    } finally {
        deadline.dispose();
    }
}

function requireMediaType(route: RouteDefinition, response: Response, expected: string): void {
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (mediaType !== expected) {
        throw new EngineApiContractError(
            route.id,
            `status ${String(response.status)} with content type ${mediaType ?? 'none'}, expected ${expected}`,
        );
    }
}

async function readJson(route: RouteDefinition, response: Response): Promise<unknown> {
    return parseJson(route, await response.text());
}

function parseJson(route: RouteDefinition, text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new EngineApiContractError(route.id, 'body is not JSON', { cause: error });
    }
}

function validate<Schema extends z.ZodType>(
    route: RouteDefinition,
    schema: Schema,
    value: unknown,
    what: string,
): z.output<Schema> {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    // Paths and issue codes only: the values may be content.
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.code}`);
    throw new EngineApiContractError(route.id, `${what} does not match the schema (${issues.join(', ')})`);
}

interface Deadline {
    readonly signal: AbortSignal;
    stopTimer(): void;
    dispose(): void;
}

/** Aborts on the caller's signal or after `timeoutMs`, with a `TimeoutError` so callers can tell the two apart. */
function startDeadline(callerSignal: AbortSignal, timeoutMs: number): Deadline {
    const controller = new AbortController();
    const onCallerAbort = (): void => {
        controller.abort(callerSignal.reason);
    };
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
        controller.abort(
            new DOMException(`Engine API request timed out after ${String(timeoutMs)} ms`, 'TimeoutError'),
        );
    }, timeoutMs);
    return {
        signal: controller.signal,
        stopTimer: () => {
            clearTimeout(timer);
        },
        dispose: () => {
            clearTimeout(timer);
            callerSignal.removeEventListener('abort', onCallerAbort);
        },
    };
}
