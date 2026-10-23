import { randomInt } from 'node:crypto';
import type { SecureContext } from 'node:tls';
import { connect as connectTls } from 'node:tls';

import type { OpenFrame, RelayId, Signer, TunnelAuth, TunnelChallenge } from '@ptbk/protocol';
import {
    EngineVersion,
    FRAME_HEADER_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    PING_INTERVAL_MS,
    TUNNEL_CLOSE_CODE,
    TUNNEL_FEATURES,
    TUNNEL_PATH,
    TUNNEL_PROTOCOL_VERSIONS,
    TUNNEL_SUBPROTOCOL,
    checkTunnelReady,
    encodeFrame,
    parseRelayMessage,
    signTunnelAuth,
} from '@ptbk/protocol';
import { WebSocket } from 'ws';

import type { TunnelDuplex } from './engine-mux';
import { createEngineMux } from './engine-mux';
import type { FleetStats } from './fleet-stats';

const ENGINE_VERSION = EngineVersion.parse('0.0.0-load');
const CONNECT_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;

// M-01's reconnect policy (mock-engine domain/tunnel/backoff.ts): full jitter, 0.5 s doubling to 10 s, reset after a
// minute of health, and a fast retry within 0.5 s when the relay drains.
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 10_000;
const HEALTHY_RESET_MS = 60_000;
const SHUTTING_DOWN_JITTER_MS = 500;

function backoffMs(failures: number): number {
    return randomInt(0, Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures, 20)) + 1);
}

export interface RelayEndpoint {
    /** Where to connect (the compose service name). */
    readonly host: string;
    readonly port: number;
    readonly relayId: RelayId;
    /** Trusts the relay's own certificate. */
    readonly secureContext: SecureContext;
}

export interface EngineTunnelOptions {
    readonly relay: RelayEndpoint;
    readonly signer: Signer;
    readonly stats: FleetStats;
    readonly onStream?: (stream: TunnelDuplex, open: OpenFrame) => void;
}

export interface EngineTunnel {
    start(): void;
    isReady(): boolean;
    stop(): void;
}

/** One engine's tunnel: dial, C-02 handshake, pings, M-01's reconnect policy. */
export function createEngineTunnel(options: EngineTunnelOptions): EngineTunnel {
    const { relay, signer, stats } = options;
    let ws: WebSocket | null = null;
    let ready = false;
    let stopped = false;
    let failures = 0;
    let retryTimer: NodeJS.Timeout | undefined;

    function retry(delayMs: number): void {
        if (stopped) return;
        stats.reconnectScheduled();
        retryTimer = setTimeout(connect, delayMs);
    }

    function connect(): void {
        if (stopped) return;
        const startedAt = performance.now();
        stats.attempt();
        let phase: 'dialing' | 'await-challenge' | 'await-ready' | 'ready' | 'ended' = 'dialing';
        let challenge: TunnelChallenge | null = null;
        let auth: TunnelAuth | null = null;
        let readyAt = 0;
        let pingTimer: NodeJS.Timeout | undefined;
        let pongTimer: NodeJS.Timeout | undefined;
        const socket = new WebSocket(`wss://${relay.relayId}${TUNNEL_PATH}`, [TUNNEL_SUBPROTOCOL], {
            createConnection: () =>
                connectTls({
                    host: relay.host,
                    port: relay.port,
                    servername: relay.relayId,
                    secureContext: relay.secureContext,
                    minVersion: 'TLSv1.2',
                }),
            perMessageDeflate: false,
            maxPayload: FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES,
            followRedirects: false,
            handshakeTimeout: CONNECT_TIMEOUT_MS,
        });
        ws = socket;
        const handshakeTimer = setTimeout(() => {
            stats.dialFailed('handshake-timeout');
            socket.terminate();
        }, HANDSHAKE_TIMEOUT_MS);
        const mux = createEngineMux({
            sendFrame: (frame) => {
                if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame(frame));
            },
            onStream: (stream, open) => {
                stats.streamOpened();
                if (options.onStream === undefined) stream.destroy();
                else options.onStream(stream, open);
            },
        });

        const ping = (): void => {
            if (pongTimer === undefined) {
                pongTimer = setTimeout(() => {
                    stats.dialFailed('pong-timeout');
                    socket.terminate();
                }, PONG_TIMEOUT_MS);
                socket.ping();
            }
            pingTimer = setTimeout(ping, PING_INTERVAL_MS);
        };

        socket.on('pong', () => {
            clearTimeout(pongTimer);
            pongTimer = undefined;
        });
        socket.on('error', (error: Error & { code?: string }) => {
            if (phase === 'dialing') stats.dialFailed(error.code ?? error.name);
        });
        socket.on('unexpected-response', (request, response) => {
            stats.dialFailed(`http-${String(response.statusCode)}`);
            request.destroy();
            socket.terminate();
        });
        socket.on('open', () => {
            phase = 'await-challenge';
            pingTimer = setTimeout(ping, PING_INTERVAL_MS);
        });
        socket.on('message', (data: Buffer, isBinary: boolean) => {
            if (isBinary) {
                if (phase !== 'ready') {
                    socket.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                    return;
                }
                const received = mux.receive(data);
                if (received.kind === 'protocol-error') {
                    stats.protocolError(received.reason);
                    socket.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                }
                return;
            }
            const parsed = parseRelayMessage(data.toString('utf8'));
            if (parsed.kind === 'invalid') {
                stats.protocolError('invalid-message');
                socket.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                return;
            }
            const message = parsed.message;
            switch (message.type) {
                case 'challenge': {
                    if (phase !== 'await-challenge') return;
                    challenge = message;
                    const offer = {
                        version: ENGINE_VERSION,
                        protocolVersions: TUNNEL_PROTOCOL_VERSIONS,
                        features: TUNNEL_FEATURES,
                    };
                    void signTunnelAuth(signer, message, offer, { dialledRelayId: relay.relayId }).then((signing) => {
                        if (signing.kind !== 'signed' || socket.readyState !== WebSocket.OPEN) return;
                        auth = signing.auth;
                        phase = 'await-ready';
                        socket.send(JSON.stringify(signing.auth));
                    });
                    return;
                }
                case 'ready':
                    if (phase !== 'await-ready' || challenge === null || auth === null) return;
                    if (checkTunnelReady(challenge, auth, message).kind !== 'ok') {
                        socket.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                        return;
                    }
                    clearTimeout(handshakeTimer);
                    phase = 'ready';
                    ready = true;
                    readyAt = performance.now();
                    stats.ready(readyAt - startedAt);
                    return;
                case 'reject':
                    stats.rejected(message.reason);
                    socket.close(1000);
                    return;
            }
        });
        socket.on('close', (code: number) => {
            clearTimeout(handshakeTimer);
            clearTimeout(pingTimer);
            clearTimeout(pongTimer);
            mux.closeAll();
            const wasReady = phase === 'ready';
            phase = 'ended';
            if (ws === socket) ws = null;
            ready = false;
            if (stopped) return;
            if (wasReady) {
                stats.lost(code);
                if (performance.now() - readyAt >= HEALTHY_RESET_MS) failures = 0;
                if (code === TUNNEL_CLOSE_CODE.REPLACED) return;
                if (code === TUNNEL_CLOSE_CODE.SHUTTING_DOWN) {
                    retry(randomInt(0, SHUTTING_DOWN_JITTER_MS + 1));
                    return;
                }
            }
            retry(backoffMs(failures));
            failures++;
        });
    }

    return {
        start() {
            connect();
        },
        isReady: () => ready,
        stop() {
            stopped = true;
            clearTimeout(retryTimer);
            ws?.close(1001);
        },
    };
}
