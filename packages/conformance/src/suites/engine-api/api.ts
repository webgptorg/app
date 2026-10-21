import { ENGINE_API_PREFIX, PROBLEM_STATUS, ProblemDetails, createSseParser } from '@ptbk/engine-api';
import type { RouteDefinition, RouteEngineData, RouteResponse, SseEventSchema, SseMessage } from '@ptbk/engine-api';

import type { CheckContext } from '../../check';
import { fail } from '../../check';
import type { SessionCredential } from '../../target';

export type ApiScope = Pick<CheckContext, 'target' | 'signal'>;

export interface ApiRequest {
    readonly params?: Readonly<Record<string, string>>;
    readonly query?: Readonly<Record<string, string | number | undefined>>;
    readonly body?: unknown;
    readonly lastEventId?: string;
    /** Replaces the browser-like defaults (`Origin`, `Sec-Fetch-Site`) for gateway checks. */
    readonly headers?: Readonly<Record<string, string>>;
}

/** What came back, before any judgement: status, headers and every byte of the body. */
export interface RawResponse {
    readonly status: number;
    readonly headers: Headers;
    readonly bytes: Uint8Array;
}

export type ApiResult<Data> =
    | { readonly kind: 'ok'; readonly status: number; readonly data: Data; readonly raw: RawResponse }
    | {
          readonly kind: 'problem';
          readonly status: number;
          readonly problem: ProblemDetails;
          readonly raw: RawResponse;
      };

export interface StreamItem {
    readonly id: string | null;
    readonly event: { readonly type: string } & Readonly<Record<string, unknown>>;
}

export interface StreamResult {
    readonly items: readonly StreamItem[];
    readonly bytes: Uint8Array;
    /** Whether the engine ended the stream, as opposed to the reader stopping. */
    readonly ended: boolean;
}

export interface StreamOptions {
    /** Stop reading once this returns `true` for an event. */
    readonly until?: (item: StreamItem) => boolean;
    /** Stop reading after this long, whatever arrived. */
    readonly maxMs: number;
}

/**
 * The engine API as the suite sees it: every request carries what a browser on the engine's origin sends (the
 * session, `Origin` and `Sec-Fetch-Site: same-origin`, since gateways refuse state-changing requests without them),
 * and every response is judged strictly against the contract. A success must match its route's strict schema and a
 * failure must be `application/problem+json` with a known code and its status; anything else fails the check.
 */
export class EngineApi {
    readonly #ctx: ApiScope;
    readonly credential: SessionCredential | null;
    readonly #observers: ((route: RouteDefinition, bytes: Uint8Array) => void)[];

    constructor(
        ctx: ApiScope,
        credential: SessionCredential | null,
        observers: ((route: RouteDefinition, bytes: Uint8Array) => void)[] = [],
    ) {
        this.#ctx = ctx;
        this.credential = credential;
        this.#observers = observers;
    }

    /** The same client under another signal, e.g. for cleanup after the check's own signal fired. */
    withSignal(signal: AbortSignal): EngineApi {
        return new EngineApi({ target: this.#ctx.target, signal }, this.credential, this.#observers);
    }

    /** Sees the raw body of every response this client reads, e.g. to search for a leaked value. */
    observe(observer: (route: RouteDefinition, bytes: Uint8Array) => void): void {
        this.#observers.push(observer);
    }

    url(route: RouteDefinition, request: ApiRequest = {}): URL {
        const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
            const value = request.params?.[name];
            if (value === undefined) throw new Error(`no value for path parameter ${name} of ${route.id}`);
            return encodeURIComponent(value);
        });
        const url = new URL(`${ENGINE_API_PREFIX}${path}`, this.#ctx.target.baseUrl);
        for (const [name, value] of Object.entries(request.query ?? {})) {
            if (value !== undefined) url.searchParams.set(name, String(value));
        }
        return url;
    }

    /** Sends a request and returns the response unjudged, with the body read to the end. */
    async send(route: RouteDefinition, request: ApiRequest = {}): Promise<RawResponse> {
        const response = await this.#fetch(route, request, this.#ctx.signal);
        const bytes = new Uint8Array(await response.arrayBuffer());
        for (const observer of this.#observers) observer(route, bytes);
        return { status: response.status, headers: response.headers, bytes };
    }

    /** Sends a request and checks the answer against the contract; JSON successes are parsed by the strict schema. */
    async call<Route extends RouteDefinition>(
        route: Route,
        request: ApiRequest = {},
    ): Promise<ApiResult<RouteEngineData<Route>>> {
        const raw = await this.send(route, request);
        return judge(route, raw) as ApiResult<RouteEngineData<Route>>;
    }

    /** Expects the route's success response. */
    async ok<Route extends RouteDefinition>(route: Route, request: ApiRequest = {}): Promise<RouteEngineData<Route>> {
        const result = await this.call(route, request);
        if (result.kind === 'problem') {
            fail(`${describe(route)}: expected success, got ${String(result.status)} ${result.problem.code}`);
        }
        return result.data;
    }

    /** Expects a problem with this code (and so its status). */
    async problem(route: RouteDefinition, request: ApiRequest, code: ProblemDetails['code']): Promise<ProblemDetails> {
        const result = await this.call(route, request);
        if (result.kind === 'ok') fail(`${describe(route)}: expected ${code}, got ${String(result.status)}`);
        if (result.problem.code !== code) {
            fail(`${describe(route)}: expected ${code}, got ${String(result.status)} ${result.problem.code}`);
        }
        return result.problem;
    }

    /**
     * Reads an SSE route until the engine ends it, `until` accepts an event or `maxMs` passes. Every event must be
     * the route's strict event schema with its `type` as the SSE event name. A problem answer fails the check.
     */
    async stream(route: RouteDefinition, request: ApiRequest, options: StreamOptions): Promise<StreamResult> {
        const success = successOf(route);
        if (success.response.kind !== 'sse') throw new Error(`${route.id} is not an SSE route`);
        const eventSchema = success.response.event;
        const stop = new AbortController();
        const timer = setTimeout(() => {
            stop.abort();
        }, options.maxMs);
        const signal = AbortSignal.any([this.#ctx.signal, stop.signal]);
        const chunks: Uint8Array[] = [];
        const items: StreamItem[] = [];
        let ended = false;
        try {
            const response = await this.#fetch(route, request, signal);
            if (response.status !== success.status) {
                const bytes = new Uint8Array(await response.arrayBuffer());
                const raw = { status: response.status, headers: response.headers, bytes };
                const result = judge(route, raw);
                fail(`${describe(route)}: expected a stream, got ${String(raw.status)}${problemSuffix(result)}`);
            }
            if (mediaType(response.headers) !== 'text/event-stream') {
                fail(`${describe(route)}: content type is ${typeOf(response.headers)}, not text/event-stream`);
            }
            if (response.body === null) fail(`${describe(route)}: stream has no body`);
            const reader = response.body.getReader();
            const parser = createSseParser();
            const handle = (messages: readonly SseMessage[]): boolean => {
                for (const message of messages) {
                    const item = parseEvent(route, eventSchema, message);
                    items.push(item);
                    if (options.until?.(item) === true) return true;
                }
                return false;
            };
            // Stop reading at once when time is up, even if the body ignores the request's signal.
            const onAbort = (): void => {
                reader.cancel().catch(() => undefined);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                for (;;) {
                    const next = await reader.read().catch((error: unknown) => {
                        if (signal.aborted) return { done: true as const, value: undefined };
                        throw error;
                    });
                    if (next.done) {
                        ended = !signal.aborted;
                        if (ended) handle(parser.end());
                        break;
                    }
                    chunks.push(next.value);
                    if (handle(parser.push(next.value))) break;
                }
            } finally {
                signal.removeEventListener('abort', onAbort);
                await reader.cancel().catch(() => undefined);
            }
        } catch (error) {
            if (!(signal.aborted && !this.#ctx.signal.aborted)) throw error;
        } finally {
            clearTimeout(timer);
        }
        const bytes = concat(chunks);
        for (const observer of this.#observers) observer(route, bytes);
        return { items, bytes, ended };
    }

    async #fetch(route: RouteDefinition, request: ApiRequest, signal: AbortSignal): Promise<Response> {
        const { baseUrl } = this.#ctx.target;
        const headers = new Headers({
            Accept: acceptFor(route),
            Origin: baseUrl.origin,
            'Sec-Fetch-Site': 'same-origin',
        });
        if (this.credential !== null) {
            if ('cookie' in this.credential) headers.set('Cookie', this.credential.cookie);
            else headers.set('Authorization', `Bearer ${this.credential.bearer}`);
        }
        if (request.lastEventId !== undefined) headers.set('Last-Event-ID', request.lastEventId);
        let body: BodyInit | undefined;
        if (request.body instanceof FormData) body = request.body;
        else if (request.body !== undefined) {
            headers.set('Content-Type', 'application/json');
            body = JSON.stringify(request.body);
        }
        for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(name, value);
        return this.#ctx.target.fetch(this.url(route, request), {
            method: route.method,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: 'manual',
            signal,
        });
    }
}

export function describe(route: RouteDefinition): string {
    return `${route.method} ${route.path}`;
}

export function successOf(route: RouteDefinition): { readonly status: number; readonly response: RouteResponse } {
    const [entry] = Object.entries(route.responses);
    if (entry === undefined) throw new Error(`${route.id} declares no success response`);
    return { status: Number(entry[0]), response: entry[1] };
}

/** The media type for a message: never the header's parameters, which an engine controls. */
function typeOf(headers: Headers): string {
    return mediaType(headers) ?? 'missing';
}

export function mediaType(headers: Headers): string | null {
    return headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? null;
}

/** Judges one response against the contract; any violation fails the check. */
export function judge(route: RouteDefinition, raw: RawResponse): ApiResult<unknown> {
    const where = `${describe(route)} → ${String(raw.status)}`;
    const success = successOf(route);
    if (raw.status === success.status)
        return { kind: 'ok', status: raw.status, data: judgeSuccess(where, success.response, raw), raw };
    if (raw.status < 400 || raw.status > 599)
        fail(`${where}: not the declared ${String(success.status)} and not a problem`);
    return { kind: 'problem', status: raw.status, problem: judgeProblem(where, raw), raw };
}

function judgeSuccess(where: string, response: RouteResponse, raw: RawResponse): unknown {
    switch (response.kind) {
        case 'json': {
            if (mediaType(raw.headers) !== 'application/json') {
                fail(`${where}: content type is ${typeOf(raw.headers)}, not application/json`);
            }
            const parsed = response.schema.safeParse(parseJson(where, raw.bytes));
            if (!parsed.success) fail(`${where}: response does not match its schema: ${issuesOf(parsed.error.issues)}`);
            return parsed.data;
        }
        case 'empty':
            if (raw.bytes.length > 0) fail(`${where}: expected an empty body, got ${String(raw.bytes.length)} bytes`);
            return null;
        case 'binary':
            if (raw.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') {
                fail(`${where}: a download needs X-Content-Type-Options: nosniff`);
            }
            if (!/^attachment\b/i.test(raw.headers.get('content-disposition') ?? '')) {
                fail(`${where}: a download needs Content-Disposition: attachment`);
            }
            return raw.bytes;
        case 'sse':
            if (mediaType(raw.headers) !== 'text/event-stream') {
                fail(`${where}: content type is ${typeOf(raw.headers)}, not text/event-stream`);
            }
            return raw.bytes;
    }
}

/** A failure answer must be RFC 9457 problem+json with a known code, sent with the status that code always has. */
export function judgeProblem(where: string, raw: RawResponse): ProblemDetails {
    if (mediaType(raw.headers) !== 'application/problem+json') {
        fail(`${where}: content type is ${typeOf(raw.headers)}, not application/problem+json`);
    }
    const parsed = ProblemDetails.safeParse(parseJson(where, raw.bytes));
    if (!parsed.success) fail(`${where}: problem does not match ProblemDetails: ${issuesOf(parsed.error.issues)}`);
    const problem = parsed.data;
    if (problem.status !== raw.status) fail(`${where}: problem says status ${String(problem.status)}`);
    if (PROBLEM_STATUS[problem.code] !== raw.status) {
        fail(`${where}: code ${problem.code} is always sent with ${String(PROBLEM_STATUS[problem.code])}`);
    }
    return problem;
}

function parseEvent(route: RouteDefinition, schema: SseEventSchema, message: SseMessage): StreamItem {
    const where = `${describe(route)} event ${message.event}`;
    let data: unknown;
    try {
        data = JSON.parse(message.data);
    } catch {
        fail(`${where}: data is not JSON`);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) fail(`${where}: event does not match its schema: ${issuesOf(parsed.error.issues)}`);
    if (parsed.data.type !== message.event)
        fail(`${where}: SSE event name differs from the event type ${parsed.data.type}`);
    return { id: message.id, event: parsed.data };
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** JSON.parse errors quote the input, which may be secret; this never does. */
function parseJson(where: string, bytes: Uint8Array): unknown {
    try {
        return JSON.parse(decoder.decode(bytes)) as unknown;
    } catch {
        return fail(`${where}: body is not UTF-8 JSON`);
    }
}

/** Paths and zod's messages only: zod names keys and expectations, never the offending values. */
export function issuesOf(
    issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
    const shown = issues
        .slice(0, 5)
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
    return [...shown, ...(issues.length > shown.length ? [`+${String(issues.length - shown.length)} more`] : [])].join(
        '; ',
    );
}

function problemSuffix(result: ApiResult<unknown>): string {
    return result.kind === 'problem' ? ` ${result.problem.code}` : '';
}

function acceptFor(route: RouteDefinition): string {
    switch (successOf(route).response.kind) {
        case 'sse':
            return 'text/event-stream';
        case 'binary':
            return '*/*';
        case 'json':
        case 'empty':
            return 'application/json, application/problem+json';
    }
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
