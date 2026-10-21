import type { IncomingHttpHeaders } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import * as tls from 'node:tls';

import { openConnectTunnel, proxyFor } from './http-connect-proxy';
import type { ProxyConfig } from './proxy-config';

export interface HttpsFetchOptions {
    /** `HTTPS_PROXY` with `NO_PROXY`, as for the relays. */
    readonly proxy: ProxyConfig | null;
    /** Trusted roots; undefined keeps Node's defaults (see `loadTrustedRoots`). */
    readonly ca?: readonly string[] | undefined;
    /** Resolves hostnames on direct connections (tests map `*.test` to 127.0.0.1). */
    readonly lookup?: LookupFunction | undefined;
}

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function responseHeaders(incoming: IncomingHttpHeaders): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
    }
    return headers;
}

function fetchFailed(cause?: unknown): TypeError {
    return new TypeError('fetch failed', cause === undefined ? undefined : { cause });
}

/**
 * A `fetch` for the dashboard: HTTPS only, through `HTTPS_PROXY` with `CONNECT` unless `NO_PROXY` exempts the host
 * (Node's built-in fetch ignores both), with the certificate checked against the URL's hostname either way. One
 * connection per request, no redirects followed. Failures carry no URL, proxy credentials or response content.
 */
export function createHttpsFetch(options: HttpsFetchOptions): typeof fetch {
    const ca = options.ca === undefined ? {} : { ca: [...options.ca] };
    const verify = { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const, ...ca };

    async function openTls(host: string, port: number, signal: AbortSignal): Promise<tls.TLSSocket> {
        const servername = isIP(host) === 0 ? { servername: host } : {};
        const proxy = proxyFor(options.proxy, host, port);
        if (proxy === null) {
            return tls.connect({
                host,
                port,
                ...servername,
                ...verify,
                ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
            });
        }
        const tunnel = await openConnectTunnel({ proxy, host, port, signal });
        if (tunnel.kind === 'failed') throw fetchFailed();
        return tls.connect({ socket: tunnel.socket, ...servername, ...verify });
    }

    return async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.protocol !== 'https:') throw new TypeError('only https URLs are fetched');
        const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
        const port = url.port === '' ? 443 : Number(url.port);
        const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
        const headers: Record<string, string> = Object.fromEntries(request.headers);
        headers['host'] = url.host;
        if (body !== undefined) headers['content-length'] = String(body.byteLength);
        request.signal.throwIfAborted();
        const socket = await openTls(host, port, request.signal);
        return new Promise<Response>((resolve, reject) => {
            const outgoing = httpRequest(
                {
                    method: request.method,
                    path: `${url.pathname}${url.search}`,
                    headers,
                    createConnection: () => socket,
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
            outgoing.once('error', (error) => {
                socket.destroy();
                const reason: unknown = request.signal.aborted ? request.signal.reason : undefined;
                reject(reason instanceof Error ? reason : fetchFailed(error));
            });
            outgoing.end(body);
        });
    };
}
