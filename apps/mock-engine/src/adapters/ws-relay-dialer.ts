import type * as net from 'node:net';
import * as tls from 'node:tls';

import { FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES, PING_INTERVAL_MS, TUNNEL_SUBPROTOCOL } from '@ptbk/protocol';
import type { Bytes } from '@ptbk/protocol';
import type { RawData } from 'ws';
import { WebSocket } from 'ws';

import type { Clock } from '../domain/clock';
import type {
    DialFailure,
    DialResult,
    RelayConnection,
    RelayConnectionHandlers,
    RelayDialer,
} from '../domain/tunnel/relay-dialer';
import type { RelayTarget } from '../domain/tunnel/relay-target';
import { openConnectTunnel, proxyFor } from './http-connect-proxy';
import type { ProxyConfig } from './proxy-config';

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;

export interface WsRelayDialerOptions {
    readonly clock: Clock;
    readonly proxy: ProxyConfig | null;
    /** Trusted roots for relay certificates; undefined keeps Node's defaults. */
    readonly ca?: readonly string[] | undefined;
    /** Resolves relay hostnames on direct connections (tests map `*.test` to 127.0.0.1). */
    readonly lookup?: net.LookupFunction | undefined;
    /** Covers the whole attempt: TCP, proxy `CONNECT`, TLS and the WebSocket upgrade. */
    readonly connectTimeoutMs?: number;
    readonly pingIntervalMs?: number;
    readonly pongTimeoutMs?: number;
}

type Step<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'failed'; readonly failure: DialFailure };

const ABORTED: DialFailure = Object.freeze({ reason: 'aborted' });

function hasErrorCode(error: unknown): error is { code: string } {
    return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

/**
 * Certificate verification fails with OpenSSL's verify codes (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`)
 * or Node's `ERR_TLS_*`/`ERR_SSL_*`; socket failures carry errno codes (`ECONNRESET`, `ENOTFOUND`).
 */
function classifyTlsError(error: unknown): DialFailure {
    const code = hasErrorCode(error) ? error.code : 'E';
    const isTls = code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || !code.startsWith('E');
    return { reason: isTls ? 'tls' : 'network' };
}

/** Calls `onAbort` now if `signal` is already aborted, otherwise once it is; returns the unsubscribe. */
function onAborted(signal: AbortSignal, onAbort: () => void): () => void {
    if (signal.aborted) {
        onAbort();
        return () => undefined;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    return () => {
        signal.removeEventListener('abort', onAbort);
    };
}

// `binaryType` stays 'nodebuffer', so ws hands over one Buffer per message, fragments already joined.
function toBytes(data: RawData): Bytes {
    return new Uint8Array(data as Buffer);
}

function toText(data: RawData): string {
    return (data as Buffer).toString('utf8');
}

export function createWsRelayDialer(options: WsRelayDialerOptions): RelayDialer {
    const { clock } = options;
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    const pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    const ca = options.ca === undefined ? {} : { ca: [...options.ca] };
    const verify = { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const };

    async function openTls(target: RelayTarget, signal: AbortSignal): Promise<Step<tls.TLSSocket>> {
        const proxy = proxyFor(options.proxy, target.relayId, target.port);
        let socket: tls.TLSSocket;
        if (proxy === null) {
            socket = tls.connect({
                host: target.relayId,
                port: target.port,
                servername: target.relayId,
                ...ca,
                ...verify,
                ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
            });
        } else {
            const tunnel = await openConnectTunnel({ proxy, host: target.relayId, port: target.port, signal });
            if (tunnel.kind === 'failed') return tunnel;
            // The certificate is checked against the relay's name, exactly as on a direct connection.
            socket = tls.connect({ socket: tunnel.socket, servername: target.relayId, ...ca, ...verify });
        }
        // A TLS socket that dies before `secureConnect` always emits `error` first, and the attempt's timeout bounds
        // anything else.
        return new Promise((resolve) => {
            let unsubscribe = (): void => undefined;
            const finish = (step: Step<tls.TLSSocket>): void => {
                unsubscribe();
                socket.off('secureConnect', onSecure);
                socket.off('error', onError);
                if (step.kind === 'failed') socket.destroy();
                resolve(step);
            };
            const onSecure = (): void => {
                finish({ kind: 'ok', value: socket });
            };
            const onError = (error: unknown): void => {
                finish({ kind: 'failed', failure: classifyTlsError(error) });
            };
            socket.once('secureConnect', onSecure);
            socket.once('error', onError);
            unsubscribe = onAborted(signal, () => {
                finish({ kind: 'failed', failure: ABORTED });
            });
        });
    }

    function connection(ws: WebSocket, handlers: RelayConnectionHandlers): RelayConnection {
        let cancelPongDeadline: (() => void) | null = null;
        const ping = (): void => {
            // One outstanding ping at a time; the deadline of the first one decides.
            if (cancelPongDeadline === null) {
                cancelPongDeadline = clock.setTimeout(() => {
                    ws.terminate();
                }, pongTimeoutMs);
                ws.ping();
            }
            cancelPing = clock.setTimeout(ping, pingIntervalMs);
        };
        let cancelPing = clock.setTimeout(ping, pingIntervalMs);
        ws.on('pong', () => {
            cancelPongDeadline?.();
            cancelPongDeadline = null;
        });
        ws.on('message', (data, isBinary) => {
            if (isBinary) handlers.onBinary(toBytes(data));
            else handlers.onText(toText(data));
        });
        ws.once('close', (code) => {
            cancelPing();
            cancelPongDeadline?.();
            cancelPongDeadline = null;
            handlers.onClose(code);
        });
        return {
            sendText(text) {
                if (ws.readyState === WebSocket.OPEN) ws.send(text);
            },
            sendBinary(bytes) {
                if (ws.readyState === WebSocket.OPEN) ws.send(bytes, { binary: true });
            },
            close(code) {
                if (ws.readyState === WebSocket.OPEN) ws.close(code);
            },
        };
    }

    function openWebSocket(
        target: RelayTarget,
        socket: tls.TLSSocket,
        handlers: RelayConnectionHandlers,
        signal: AbortSignal,
    ): Promise<DialResult> {
        return new Promise((resolve) => {
            const ws = new WebSocket(target.url, [TUNNEL_SUBPROTOCOL], {
                createConnection: () => socket,
                perMessageDeflate: false,
                maxPayload: FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES,
                followRedirects: false,
            });
            let settled = false;
            let unsubscribe = (): void => undefined;
            const fail = (failure: DialFailure): void => {
                if (settled) return;
                settled = true;
                unsubscribe();
                ws.terminate();
                socket.destroy();
                resolve({ kind: 'failed', failure });
            };
            ws.once('unexpected-response', (request, response) => {
                request.destroy();
                fail({ reason: 'upgrade-status', status: Number(response.statusCode) });
            });
            // Stays attached after open: ws follows every error with `close`, which is what the link acts on.
            ws.on('error', (error) => {
                fail(hasErrorCode(error) ? { reason: 'network' } : { reason: 'protocol' });
            });
            ws.once('close', () => {
                fail({ reason: 'network' });
            });
            ws.once('open', () => {
                settled = true;
                unsubscribe();
                resolve({ kind: 'open', connection: connection(ws, handlers) });
            });
            unsubscribe = onAborted(signal, () => {
                fail(ABORTED);
            });
        });
    }

    return {
        async dial(target, handlers, signal) {
            const attempt = new AbortController();
            // The first of timeout and caller abort wins; the steps only see that the attempt was aborted.
            const outcome: { abortedBy: DialFailure | null } = { abortedBy: null };
            const abort = (reason: DialFailure): void => {
                if (outcome.abortedBy !== null) return;
                outcome.abortedBy = reason;
                attempt.abort();
            };
            const unsubscribe = onAborted(signal, () => {
                abort(ABORTED);
            });
            const cancelTimeout = clock.setTimeout(() => {
                abort({ reason: 'timeout' });
            }, connectTimeoutMs);
            try {
                const opened = await openTls(target, attempt.signal);
                const result =
                    opened.kind === 'ok' ? await openWebSocket(target, opened.value, handlers, attempt.signal) : opened;
                if (result.kind === 'failed' && outcome.abortedBy !== null) {
                    return { kind: 'failed', failure: outcome.abortedBy };
                }
                return result;
            } finally {
                cancelTimeout();
                unsubscribe();
            }
        },
    };
}
