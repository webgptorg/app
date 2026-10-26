import type { Duplex } from 'node:stream';

export interface HttpResponse {
    readonly status: number;
    /** Lowercased names; a repeated header keeps its last value. */
    readonly headers: ReadonlyMap<string, string>;
    readonly body: Buffer;
}

export type ResponsesRead =
    | { readonly kind: 'ok'; readonly responses: readonly HttpResponse[] }
    | { readonly kind: 'failed'; readonly reason: string; readonly responses: readonly HttpResponse[] };

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type Parse = { readonly kind: 'response'; readonly response: HttpResponse; readonly used: number } | { kind: 'more' };

class HttpParseError extends Error {}

function parseChunked(buffer: Buffer, start: number): { body: Buffer; end: number } | null {
    const parts: Buffer[] = [];
    let offset = start;
    for (;;) {
        const lineEnd = buffer.indexOf('\r\n', offset);
        if (lineEnd < 0) return null;
        const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0] ?? '', 16);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BODY_BYTES) throw new HttpParseError('bad chunk');
        offset = lineEnd + 2;
        if (size === 0) {
            // No trailers are expected; the last chunk ends with an empty line.
            const trailerEnd = buffer.indexOf('\r\n', offset);
            if (trailerEnd < 0) return null;
            return { body: Buffer.concat(parts), end: trailerEnd + 2 };
        }
        if (buffer.length < offset + size + 2) return null;
        parts.push(buffer.subarray(offset, offset + size));
        offset += size + 2;
    }
}

/** One response from the start of `buffer`, for a request that was not HEAD. */
function parseResponse(buffer: Buffer): Parse {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
        if (buffer.length > MAX_HEADER_BYTES) throw new HttpParseError('header too long');
        return { kind: 'more' };
    }
    const [statusLine = '', ...lines] = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
    const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine);
    if (match === null) throw new HttpParseError('not an HTTP/1.1 status line');
    const headers = new Map<string, string>();
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon <= 0) throw new HttpParseError('bad header line');
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const status = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (status === 204 || status === 304 || (status >= 100 && status < 200)) {
        return { kind: 'response', response: { status, headers, body: Buffer.alloc(0) }, used: bodyStart };
    }
    if (headers.get('transfer-encoding')?.toLowerCase() === 'chunked') {
        const chunked = parseChunked(buffer, bodyStart);
        if (chunked === null) return { kind: 'more' };
        return { kind: 'response', response: { status, headers, body: chunked.body }, used: chunked.end };
    }
    const length = Number(headers.get('content-length') ?? '0');
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES) {
        throw new HttpParseError('bad content-length');
    }
    if (buffer.length < bodyStart + length) return { kind: 'more' };
    const body = Buffer.from(buffer.subarray(bodyStart, bodyStart + length));
    return { kind: 'response', response: { status, headers, body }, used: bodyStart + length };
}

export type ResponseRead =
    | { readonly kind: 'ok'; readonly response: HttpResponse }
    | { readonly kind: 'failed'; readonly reason: string; readonly timedOut: boolean };

/**
 * HTTP/1.1 responses from `socket`, one `next()` at a time, keeping partial bytes between calls: a response the engine
 * could only half send (out of credit) completes on a later call. `Content-Length` and chunked bodies, which is all an
 * engine API answer uses.
 */
export class ResponseReader {
    readonly #socket: Duplex;
    #buffer = Buffer.alloc(0);
    #ended: string | null = null;
    #wake: (() => void) | null = null;

    constructor(socket: Duplex) {
        this.#socket = socket;
        socket.on('data', (chunk: Buffer) => {
            this.#buffer = Buffer.concat([this.#buffer, chunk]);
            this.#wake?.();
        });
        const end = (reason: string): void => {
            this.#ended ??= reason;
            this.#wake?.();
        };
        socket.once('end', () => {
            end('the connection ended before the response was complete');
        });
        socket.once('close', () => {
            end('the connection closed before the response was complete');
        });
        socket.once('error', (error: Error) => {
            end(`connection error (${error.name})`);
        });
    }

    async next(timeoutMs: number): Promise<ResponseRead> {
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            let parsed: Parse;
            try {
                parsed = parseResponse(this.#buffer);
            } catch (error) {
                return { kind: 'failed', reason: (error as Error).message, timedOut: false };
            }
            if (parsed.kind === 'response') {
                this.#buffer = this.#buffer.subarray(parsed.used);
                return { kind: 'ok', response: parsed.response };
            }
            if (this.#ended !== null) return { kind: 'failed', reason: this.#ended, timedOut: false };
            const left = deadline - performance.now();
            if (left <= 0)
                return {
                    kind: 'failed',
                    reason: `no complete response within ${String(timeoutMs)} ms`,
                    timedOut: true,
                };
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, left);
                this.#wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
            this.#wake = null;
        }
    }

    /** Stops listening; for a socket handed on to something else. */
    detach(): void {
        this.#socket.removeAllListeners('data');
    }
}

/** Reads `count` responses in a row; used where the requests went out one after another. */
export async function readResponses(socket: Duplex, count: number, timeoutMs: number): Promise<ResponsesRead> {
    const reader = new ResponseReader(socket);
    const responses: HttpResponse[] = [];
    const deadline = performance.now() + timeoutMs;
    while (responses.length < count) {
        const read = await reader.next(Math.max(1, deadline - performance.now()));
        if (read.kind === 'failed') return { kind: 'failed', reason: read.reason, responses };
        responses.push(read.response);
    }
    return { kind: 'ok', responses };
}

export interface RequestOptions {
    readonly method?: string;
    readonly host: string;
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    /** Asks the engine to end the connection after answering. */
    readonly close?: boolean;
}

export function requestBytes(options: RequestOptions): Buffer {
    const headers = {
        Host: options.host,
        Accept: 'application/json',
        Connection: options.close === true ? 'close' : 'keep-alive',
        ...options.headers,
    };
    const lines = [`${options.method ?? 'GET'} ${options.path} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}
