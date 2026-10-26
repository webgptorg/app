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

/**
 * Reads `count` HTTP/1.1 responses from `socket` (pipelined requests answer in order). Supports `Content-Length` and
 * chunked bodies, which is all an engine API answer uses; responses must not rely on the connection closing.
 */
export function readResponses(socket: Duplex, count: number, timeoutMs: number): Promise<ResponsesRead> {
    return new Promise((resolve) => {
        const responses: HttpResponse[] = [];
        let buffer = Buffer.alloc(0);
        const finish = (result: ResponsesRead): void => {
            clearTimeout(timer);
            socket.off('data', onData);
            socket.off('end', onEnd);
            socket.off('close', onEnd);
            socket.off('error', onError);
            resolve(result);
        };
        const onData = (chunk: Buffer): void => {
            buffer = Buffer.concat([buffer, chunk]);
            try {
                for (;;) {
                    const parsed = parseResponse(buffer);
                    if (parsed.kind === 'more') return;
                    responses.push(parsed.response);
                    buffer = buffer.subarray(parsed.used);
                    if (responses.length === count) {
                        finish({ kind: 'ok', responses });
                        return;
                    }
                }
            } catch (error) {
                finish({ kind: 'failed', reason: (error as Error).message, responses });
            }
        };
        const onEnd = (): void => {
            finish({ kind: 'failed', reason: 'the connection ended before every response arrived', responses });
        };
        const onError = (error: Error): void => {
            finish({ kind: 'failed', reason: `connection error (${error.name})`, responses });
        };
        const timer = setTimeout(() => {
            finish({ kind: 'failed', reason: `no complete response within ${String(timeoutMs)} ms`, responses });
        }, timeoutMs);
        socket.on('data', onData);
        socket.once('end', onEnd);
        socket.once('close', onEnd);
        socket.once('error', onError);
    });
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
