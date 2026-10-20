import type { IncomingHttpHeaders } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function responseHeaders(incoming: IncomingHttpHeaders): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
    return headers;
}

/**
 * A `fetch` over a connection the test opens itself (a TLS socket over the in-test tunnel or through the in-test
 * relay), so the engine API's fetch client runs against the real HTTP server with nothing faked in between. Each
 * request gets its own connection; aborting the signal destroys it, as a browser closing the tab would.
 */
export function createNodeFetch(options: { readonly connect: () => Duplex; readonly host: string }): typeof fetch {
    return async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
        const headers: Record<string, string> = Object.fromEntries(request.headers);
        headers['host'] = options.host;
        if (body !== undefined) headers['content-length'] = String(body.byteLength);
        return new Promise<Response>((resolve, reject) => {
            const outgoing = httpRequest(
                {
                    method: request.method,
                    path: `${url.pathname}${url.search}`,
                    headers,
                    createConnection: options.connect,
                    signal: request.signal,
                },
                (incoming) => {
                    const status = incoming.statusCode ?? 0;
                    const stream = NULL_BODY_STATUSES.has(status)
                        ? null
                        : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
                    if (stream === null) incoming.resume();
                    resolve(new Response(stream, { status, headers: responseHeaders(incoming.headers) }));
                },
            );
            outgoing.once('error', reject);
            outgoing.end(body);
        });
    };
}

/** Adds what a browser on the engine's origin sends: the session cookie and Fetch Metadata. */
export function asBrowser(base: typeof fetch, origin: string, cookie: () => string | null): typeof fetch {
    return async (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        const value = cookie();
        if (value !== null) headers.set('cookie', value);
        headers.set('origin', origin);
        headers.set('sec-fetch-site', 'same-origin');
        const body = request.body === null ? null : await request.arrayBuffer();
        return base(request.url, { method: request.method, headers, body, signal: request.signal });
    };
}
