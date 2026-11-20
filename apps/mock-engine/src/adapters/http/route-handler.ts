import type { ProblemCode, ProblemExtras } from '@ptbk/engine-api';
import { createProblem } from '@ptbk/engine-api';
import type { Actor } from '@ptbk/engine-api/in-memory';
import type { z } from 'zod';

import type { RateLimiter } from '../../domain/rate-limit/rate-limiter';
import type { SecureConnection } from '../tls-stream-server';
import type { HttpRoute, Route, StringFields } from './route';

interface ValidationError {
    readonly path: string;
    readonly message: string;
}

export interface Problem {
    readonly code: ProblemCode;
    readonly extras?: ProblemExtras;
    readonly retryAfterS?: number;
}

export function problemResponse(problem: Problem): Response {
    const body = createProblem(problem.code, problem.extras);
    const headers = new Headers({ 'Content-Type': 'application/problem+json' });
    if (problem.retryAfterS !== undefined) headers.set('Retry-After', String(problem.retryAfterS));
    return new Response(JSON.stringify(body), { status: body.status, headers });
}

/** Repeated parameters are refused outright: a schema should never have to choose between two values. */
/** Null-prototype records, so names like `__proto__` and `constructor` are plain keys the strict schema refuses. */
function emptyRecord<T>(): Record<string, T> {
    return Object.create(null) as Record<string, T>;
}

function queryOf(url: URL): Record<string, string> | null {
    const query = emptyRecord<string>();
    for (const [name, value] of url.searchParams) {
        if (Object.hasOwn(query, name)) return null;
        query[name] = value;
    }
    return query;
}

function headersOf(schema: StringFields, read: (name: string) => string | undefined): Record<string, string> {
    return Object.fromEntries(
        Object.keys(schema.shape).flatMap((name) => {
            const value = read(name);
            return value === undefined ? [] : [[name, value]];
        }),
    );
}

/** The same shape the engine API's own validation answers with, so a client cannot tell which layer refused. */
function check(location: string, schema: z.ZodType, value: unknown, errors: ValidationError[]): unknown {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues) {
        // Zod names unknown keys in its message; a key is input too (`/setup?<secret>`), so it is never echoed.
        const message = issue.code === 'unrecognized_keys' ? 'Unrecognized key' : issue.message;
        errors.push({ path: [location, ...issue.path.map(String)].join('.'), message });
    }
    return undefined;
}

/** Per client IP, under the route's named policy. */
export function rateLimited(route: Route, limiter: RateLimiter, clientIp: string): Problem | null {
    const decision = limiter.consume(route.rateLimit, clientIp);
    if (decision.kind === 'allowed') return null;
    return { code: 'rate-limited', retryAfterS: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)) };
}

/** Query and headers for any route, WebSocket upgrades included. */
export function admitQueryAndHeaders(
    route: Route,
    url: URL,
    readHeader: (name: string) => string | undefined,
): { readonly kind: 'ok'; readonly query: unknown; readonly headers: unknown } | Problem {
    const raw = queryOf(url);
    if (raw === null) return { code: 'validation-failed', extras: { detail: 'repeated query parameter' } };
    const errors: ValidationError[] = [];
    const query = check('query', route.query, raw, errors);
    const headers =
        route.headers === null ? null : check('headers', route.headers, headersOf(route.headers, readHeader), errors);
    if (errors.length > 0) return { code: 'validation-failed', extras: { errors } };
    return { kind: 'ok', query, headers };
}

/** A route without a body still reads a little, so a stray body is refused as such (400), not as too large. */
const STRAY_BODY_MAX_BYTES = 1024;

type BodyRead = { readonly kind: 'ok'; readonly bytes: Uint8Array<ArrayBuffer> | null } | Problem;

/** Reads at most `maxBytes`, whatever `Content-Length` claims. */
async function readBounded(request: Request, maxBytes: number): Promise<BodyRead> {
    const declared = request.headers.get('content-length');
    if (declared !== null && Number(declared) > maxBytes) return { code: 'payload-too-large' };
    if (request.body === null) return { kind: 'ok', bytes: null };
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return { code: 'payload-too-large' };
        }
        chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { kind: 'ok', bytes };
}

function mediaTypeOf(request: Request): string | undefined {
    return request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
}

async function decodeBody(
    route: HttpRoute,
    request: Request,
    bytes: Uint8Array<ArrayBuffer> | null,
): Promise<{ readonly kind: 'ok'; readonly value: unknown } | Problem> {
    const body = route.body;
    if (body === null) {
        return bytes === null || bytes.byteLength === 0
            ? { kind: 'ok', value: null }
            : {
                  code: 'validation-failed',
                  extras: { errors: [{ path: 'body', message: 'Not allowed for this route.' }] },
              };
    }
    const text = (): string => new TextDecoder().decode(bytes ?? new Uint8Array());
    switch (body.kind) {
        case 'json':
            if (mediaTypeOf(request) !== 'application/json') return { code: 'unsupported-media-type' };
            try {
                return { kind: 'ok', value: JSON.parse(text()) as unknown };
            } catch {
                return {
                    code: 'validation-failed',
                    extras: { errors: [{ path: 'body', message: 'Body is not valid JSON' }] },
                };
            }
        case 'form': {
            if (mediaTypeOf(request) !== 'application/x-www-form-urlencoded') return { code: 'unsupported-media-type' };
            const form = emptyRecord<string>();
            for (const [name, value] of new URLSearchParams(text())) {
                if (Object.hasOwn(form, name)) {
                    return {
                        code: 'validation-failed',
                        extras: { errors: [{ path: `body.${name}`, message: 'Repeated field' }] },
                    };
                }
                form[name] = value;
            }
            return { kind: 'ok', value: form };
        }
        case 'binary':
            return {
                kind: 'ok',
                value: new Blob(bytes === null ? [] : [bytes], { type: request.headers.get('content-type') ?? '' }),
            };
        case 'multipart': {
            try {
                const parsed = await new Response(bytes, { headers: request.headers }).formData();
                const value = emptyRecord<FormDataEntryValue>();
                for (const [name, entry] of parsed) value[name] = entry;
                return { kind: 'ok', value };
            } catch {
                return { code: 'unsupported-media-type' };
            }
        }
    }
}

export interface RequestContext {
    readonly request: Request;
    readonly params: Readonly<Record<string, string>>;
    readonly connection: SecureConnection | null;
    readonly clientIp: string;
    readonly actor: Actor | null;
}

/**
 * Strict input for an HTTP route, after its rate limit and authentication: path parameters, query, headers and the
 * size-capped body, each through its schema. The handler sees only parsed values (and a re-readable copy of the
 * request for handlers that hand it on, such as the engine API binding).
 */
export async function runHttpRoute(route: HttpRoute, context: RequestContext): Promise<Response> {
    if (route.validation === 'engine-api') return runEngineApiRoute(route, context);
    const { request } = context;
    const admitted = admitQueryAndHeaders(
        route,
        new URL(request.url),
        (name) => request.headers.get(name) ?? undefined,
    );
    if (!('kind' in admitted)) return problemResponse(admitted);
    const errors: ValidationError[] = [];
    const params = route.params === null ? null : check('params', route.params, context.params, errors);
    if (errors.length > 0) return problemResponse({ code: 'validation-failed', extras: { errors } });
    const read = await readBounded(request, route.body?.maxBytes ?? STRAY_BODY_MAX_BYTES);
    if (!('kind' in read)) return problemResponse(read);
    const decoded = await decodeBody(route, request, read.bytes);
    if (!('kind' in decoded)) return problemResponse(decoded);
    const body = route.body === null ? null : check('body', route.body.schema, decoded.value, errors);
    if (errors.length > 0) return problemResponse({ code: 'validation-failed', extras: { errors } });
    return route.handle({
        params,
        query: admitted.query,
        headers: admitted.headers,
        body,
        request: copyOf(request, read.bytes),
        connection: context.connection,
        clientIp: context.clientIp,
        actor: context.actor,
        signal: request.signal,
    } as Parameters<HttpRoute['handle']>[0]);
}

function copyOf(request: Request, bytes: Uint8Array<ArrayBuffer> | null): Request {
    return new Request(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        ...(bytes === null ? {} : { body: bytes }),
    });
}

/**
 * The engine API binding parses params, query and body itself, strictly and with these same schemas, but only after
 * the capability and permission checks, as C-04 orders them: a caller without the permission learns 403, not whether
 * their input was valid. The helper still caps the body and checks the headers it declares.
 */
async function runEngineApiRoute(route: HttpRoute, context: RequestContext): Promise<Response> {
    const { request } = context;
    const errors: ValidationError[] = [];
    const headers =
        route.headers === null
            ? null
            : check(
                  'headers',
                  route.headers,
                  headersOf(route.headers, (name) => request.headers.get(name) ?? undefined),
                  errors,
              );
    if (errors.length > 0) return problemResponse({ code: 'validation-failed', extras: { errors } });
    const read = await readBounded(request, route.body?.maxBytes ?? STRAY_BODY_MAX_BYTES);
    if (!('kind' in read)) return problemResponse(read);
    return route.handle({
        params: context.params,
        query: null,
        headers,
        body: null,
        request: copyOf(request, read.bytes),
        connection: context.connection,
        clientIp: context.clientIp,
        actor: context.actor,
        signal: request.signal,
    } as unknown as Parameters<HttpRoute['handle']>[0]);
}

/** Hono's `:name` form of a `{name}` path; `{name+}` is the rest of the path, one or more segments. */
export function honoPath(path: string): string {
    return path.replace(/\{(\w+)\+\}/g, ':$1{.+}').replace(/\{(\w+)\}/g, ':$1');
}

/** Whether a path ends in a `{name+}` segment, which matches whatever no other route took. */
export function isCatchAll(path: string): boolean {
    return /\{\w+\+\}$/.test(path);
}

/**
 * More literal segments first, so `/agents/validate` wins over `/agents/{agentId}` (Hono runs routes in order), and
 * catch-all routes last of all.
 */
export function bySpecificity(a: Route, b: Route): number {
    const literals = (route: Route): number =>
        route.path.split('/').filter((segment) => segment !== '' && !segment.startsWith('{')).length;
    return Number(isCatchAll(a.path)) - Number(isCatchAll(b.path)) || literals(b) - literals(a);
}
