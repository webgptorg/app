import * as http from 'node:http';
import { Readable } from 'node:stream';
import type { TLSSocket } from 'node:tls';

import type { RelayTunnel } from '../fake-relay/relay-tunnel';
import { certificateProblem, connectThroughTunnel } from './through-stream';

export interface TunnelFetchOptions {
    /** The engine's hostname: SNI, `Host` and the only origin this fetch reaches. */
    readonly hostname: string;
    /** A ready tunnel to the engine, for each request. */
    readonly tunnel: () => Promise<RelayTunnel>;
    /** The engine certificate's trust anchor; null checks only its name and dates. */
    readonly certificateAuthority: () => Promise<string | null>;
    /** For the TLS handshake through the stream. */
    readonly handshakeMs: number;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** A TLS connection to the engine through a new tunnel stream, its certificate checked: one browser connection. */
export async function connectToEngine(options: TunnelFetchOptions): Promise<TLSSocket> {
    const ca = await options.certificateAuthority();
    const connected = await connectThroughTunnel(await options.tunnel(), {
        servername: options.hostname,
        certificateAuthorityPem: ca,
        timeoutMs: options.handshakeMs,
    });
    if (connected.kind === 'failed') throw new TypeError(`fetch through the tunnel failed: ${connected.reason}`);
    const { socket } = connected;
    const problem = certificateProblem(connected.certificate, options.hostname);
    if (problem !== null) {
        socket.destroy();
        throw new TypeError(`fetch through the tunnel failed: ${problem}`);
    }
    return socket;
}

/**
 * A `fetch` for `https://<hostname>/…` whose requests travel as a browser's would: a new tunnel stream per request,
 * a TLS client inside it ending at the engine, HTTP/1.1 over that. Response bodies stream (SSE works), and the
 * request's signal aborts the stream. Anything but the engine's origin is refused.
 */
export function createTunnelFetch(options: TunnelFetchOptions): typeof fetch {
    return async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.protocol !== 'https:' || url.hostname !== options.hostname || url.port !== '') {
            throw new TypeError(`this fetch reaches only https://${options.hostname}`);
        }
        request.signal.throwIfAborted();
        const socket = await connectToEngine(options);
        const body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
        const headers: Record<string, string> = { ...Object.fromEntries(request.headers), host: options.hostname };
        headers['connection'] = 'close';
        if (body !== undefined) headers['content-length'] = String(body.length);

        return new Promise<Response>((resolve, reject) => {
            // No agent: with `createConnection` and no agent, Node uses exactly this socket for the request.
            const outgoing = http.request({
                createConnection: () => socket,
                method: request.method,
                path: `${url.pathname}${url.search}`,
                headers,
                setHost: false,
            });
            const abort = (): void => {
                outgoing.destroy(request.signal.reason instanceof Error ? request.signal.reason : new Error('aborted'));
                socket.destroy();
            };
            request.signal.addEventListener('abort', abort, { once: true });
            outgoing.once('error', (error) => {
                request.signal.removeEventListener('abort', abort);
                socket.destroy();
                reject(new TypeError(`fetch through the tunnel failed (${error.name})`));
            });
            outgoing.once('response', (incoming) => {
                incoming.once('close', () => {
                    request.signal.removeEventListener('abort', abort);
                    socket.destroy();
                });
                const responseHeaders = new Headers();
                const raw = incoming.rawHeaders;
                // `rawHeaders` alternates names and values, so every even index has a value after it.
                for (let index = 0; index < raw.length; index += 2) {
                    responseHeaders.append(raw[index] as string, raw[index + 1] as string);
                }
                const status = incoming.statusCode ?? 502;
                const stream = NULL_BODY_STATUSES.has(status)
                    ? null
                    : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>);
                if (stream === null) incoming.resume();
                resolve(
                    new Response(stream, {
                        status,
                        statusText: incoming.statusMessage ?? '',
                        headers: responseHeaders,
                    }),
                );
            });
            outgoing.end(body);
        });
    };
}
