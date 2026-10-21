import { createEngineApiClient, EngineApiContractError } from './client';
import type {
    EngineApiClient,
    EngineApiResponse,
    EngineApiTransport,
    EngineApiTransportRequest,
    UploadProgress,
} from './client';
import { ProblemDetails } from './common';
import { ENGINE_API_PREFIX } from './constants';
import type { EngineApiStreamItem, RouteDefinition, RouteResponse, SuccessStatus } from './route';
import { readJsonResponse, readStreamEvent, readTolerantly } from './reader';
import { parseSseStream } from './sse';

export interface FetchEngineApiClientOptions {
    /** The engine's origin, e.g. `location.origin` in the UI. */
    readonly baseUrl: string;
    readonly fetch: typeof fetch;
    /**
     * Until the response is complete; for SSE, until the stream has started. An upload that reports progress restarts
     * it with every progress event, so a large file on a slow link is limited by stalls, not by its size.
     */
    readonly timeoutMs: number;
    /**
     * Sends uploads that ask for progress, which `fetch` cannot observe; in the browser `() => new XMLHttpRequest()`.
     * Without it such an upload goes through `fetch` and reports progress only once it is accepted.
     */
    readonly createXhr?: () => XMLHttpRequest;
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
            const url = requestUrl(options.baseUrl, route, request);
            const headers = requestHeaders(route, success, request);
            const upload =
                request.onUploadProgress === undefined
                    ? undefined
                    : await encodeUpload(route, request, request.onUploadProgress, deadline);
            const response = await (upload !== undefined && options.createXhr !== undefined
                ? sendWithXhr(options.createXhr, url, {
                      method: route.method,
                      headers: { ...headers, 'content-type': upload.contentType },
                      body: upload.body,
                      signal: deadline.signal,
                      onProgress: upload.report,
                  })
                : options.fetch(url, {
                      method: route.method,
                      headers: upload === undefined ? headers : { ...headers, 'content-type': upload.contentType },
                      body: upload === undefined ? requestBody(route, request) : upload.body,
                      credentials: 'same-origin',
                      cache: 'no-store',
                      // A redirect here means a proxy or a sign-in page answered instead of the API: fail loudly.
                      redirect: 'error',
                      signal: deadline.signal,
                  }));
            if (response.status === status) {
                upload?.report(upload.body.size);
                if (success.kind === 'sse') {
                    streaming = true;
                    deadline.stopTimer();
                    return { kind: 'ok', data: decodeSse(route, success, response, deadline) };
                }
                return { kind: 'ok', data: await decodeSuccess(route, success, response) };
            }
            return await decodeProblem(route, response);
        } finally {
            if (!streaming) deadline.dispose();
        }
    };
}

interface EncodedUpload {
    readonly body: Blob;
    readonly contentType: string;
    /** Reports bytes sent, never past the body's size or backwards, and restarts the deadline. */
    readonly report: (loadedBytes: number) => void;
}

/** Encodes the multipart body up front, so its exact size is known whichever way it is sent. */
async function encodeUpload(
    route: RouteDefinition,
    request: EngineApiTransportRequest,
    onProgress: (progress: UploadProgress) => void,
    deadline: Deadline,
): Promise<EncodedUpload> {
    if (route.body?.kind !== 'multipart') throw new Error(`Route ${route.id} has no multipart body to report on`);
    const encoded = new Response(requestBody(route, request));
    const contentType = encoded.headers.get('content-type');
    if (contentType === null) throw new Error(`Route ${route.id} multipart body has no content type`);
    const body = await encoded.blob();
    let sent = -1;
    return {
        body,
        contentType,
        report: (loadedBytes) => {
            const loaded = Math.min(Math.max(loadedBytes, 0), body.size);
            if (loaded <= sent) return;
            sent = loaded;
            deadline.restartTimer();
            onProgress({ loadedBytes: loaded, totalBytes: body.size });
        },
    };
}

interface XhrRequest {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Blob;
    readonly signal: AbortSignal;
    readonly onProgress: (loadedBytes: number) => void;
}

/** Statuses whose response has no body; `new Response` refuses one for them. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** A same-origin `XMLHttpRequest` that answers like `fetch` with `redirect: 'error'`, for upload progress. */
function sendWithXhr(createXhr: () => XMLHttpRequest, url: URL, request: XhrRequest): Promise<Response> {
    return new Promise((resolve, reject) => {
        const { signal } = request;
        if (signal.aborted) {
            reject(signal.reason as Error);
            return;
        }
        const xhr = createXhr();
        const onAbort = (): void => {
            xhr.abort();
        };
        const settle = (outcome: () => void): void => {
            signal.removeEventListener('abort', onAbort);
            outcome();
        };
        xhr.open(request.method, url.href);
        xhr.responseType = 'blob';
        for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
        xhr.upload.addEventListener('progress', (event) => {
            request.onProgress(event.loaded);
        });
        xhr.addEventListener('load', () => {
            settle(() => {
                // XHR follows redirects without telling; `fetch` here refuses them, so a moved answer fails the same way.
                if (xhr.responseURL !== url.href) {
                    reject(new TypeError('Engine API request was redirected'));
                    return;
                }
                const body = NULL_BODY_STATUSES.has(xhr.status) ? null : (xhr.response as Blob | null);
                resolve(new Response(body, { status: xhr.status, headers: parseHeaders(xhr.getAllResponseHeaders()) }));
            });
        });
        xhr.addEventListener('error', () => {
            settle(() => {
                reject(new TypeError('Engine API request failed'));
            });
        });
        xhr.addEventListener('abort', () => {
            settle(() => {
                reject(signal.reason as Error);
            });
        });
        signal.addEventListener('abort', onAbort, { once: true });
        xhr.send(request.body);
    });
}

function parseHeaders(raw: string): Headers {
    const headers = new Headers();
    for (const line of raw.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    return headers;
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
            return readJsonResponse(route, success, await readJson(route, response));
    }
}

async function decodeProblem(route: RouteDefinition, response: Response): Promise<EngineApiResponse<never>> {
    requireMediaType(route, response, 'application/problem+json');
    const problem = readTolerantly(
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
    success: Extract<RouteResponse, { kind: 'sse' }>,
    response: Response,
    deadline: Deadline,
): AsyncIterable<EngineApiStreamItem<unknown>> {
    try {
        requireMediaType(route, response, 'text/event-stream');
        if (!response.body) throw new EngineApiContractError(route.id, 'event stream without a body');
        for await (const message of parseSseStream(response.body, deadline.signal)) {
            const data = parseJson(route, message.data);
            const type =
                typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['type'] : undefined;
            if (type !== message.event) {
                throw new EngineApiContractError(route.id, 'SSE event name differs from the event type');
            }
            const event = readStreamEvent(route, success, data);
            if (event !== undefined) yield { id: message.id, event };
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

interface Deadline {
    readonly signal: AbortSignal;
    stopTimer(): void;
    /** Gives the request `timeoutMs` again from now, unless it already timed out. */
    restartTimer(): void;
    dispose(): void;
}

/** Aborts on the caller's signal or after `timeoutMs`, with a `TimeoutError` so callers can tell the two apart. */
function startDeadline(callerSignal: AbortSignal, timeoutMs: number): Deadline {
    const controller = new AbortController();
    const onCallerAbort = (): void => {
        controller.abort(callerSignal.reason);
    };
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    const onTimeout = (): void => {
        controller.abort(
            new DOMException(`Engine API request timed out after ${String(timeoutMs)} ms`, 'TimeoutError'),
        );
    };
    let timer = setTimeout(onTimeout, timeoutMs);
    let disposed = false;
    return {
        signal: controller.signal,
        stopTimer: () => {
            clearTimeout(timer);
        },
        restartTimer: () => {
            if (disposed || controller.signal.aborted) return;
            clearTimeout(timer);
            timer = setTimeout(onTimeout, timeoutMs);
        },
        dispose: () => {
            disposed = true;
            clearTimeout(timer);
            callerSignal.removeEventListener('abort', onCallerAbort);
        },
    };
}
