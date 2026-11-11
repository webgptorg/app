export type Fetched =
    | {
          readonly kind: 'response';
          readonly status: number;
          readonly headers: Headers;
          readonly body: Uint8Array<ArrayBuffer>;
      }
    | { readonly kind: 'failed'; readonly reason: string };

export interface BoundedGetOptions {
    readonly headers: Readonly<Record<string, string>>;
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
}

/**
 * A `GET` that never follows a redirect (the gateway's redirect is what a check looks at), gives up after the timeout
 * and stops reading past `maxBytes`. Network errors are an outcome, since an unreachable engine is what this reports.
 */
export async function boundedGet(fetchFn: typeof fetch, url: URL, options: BoundedGetOptions): Promise<Fetched> {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
    try {
        const response = await fetchFn(url, { method: 'GET', headers: options.headers, redirect: 'manual', signal });
        const body = await readCapped(response, options.maxBytes);
        if (body === null) return { kind: 'failed', reason: `the body is over ${String(options.maxBytes)} bytes` };
        return { kind: 'response', status: response.status, headers: response.headers, body };
    } catch (error) {
        if (signal.aborted && !options.signal.aborted) {
            return { kind: 'failed', reason: `no answer within ${String(options.timeoutMs)} ms` };
        }
        return { kind: 'failed', reason: describe(error) };
    }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
    if (response.body === null) return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.length;
    }
    return body;
}

/** Node's fetch hides the socket error in `cause`; that code is what tells a reset tunnel from a bad certificate. */
function describe(error: unknown): string {
    const cause =
        error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
    if (typeof cause?.code === 'string') return `${error instanceof Error ? error.message : 'failed'} (${cause.code})`;
    return error instanceof Error ? error.message : String(error);
}

/** The media type of a response, lower case, without parameters. */
export function mediaType(fetched: Extract<Fetched, { kind: 'response' }>): string | null {
    const value = fetched.headers.get('content-type');
    if (value === null) return null;
    return (value.split(';')[0] ?? '').trim().toLowerCase();
}
