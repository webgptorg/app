import type { EngineId, Hostname, RelayId, TunnelChallenge } from '@ptbk/protocol';
import { TUNNEL_CLOSE_CODE, TunnelReady } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { DnsResolver } from '../dns-resolver';
import type { EngineRegistry } from '../engine-registry';
import type { Logger } from '../logger';
import type { Random } from '../random';
import type { RelayTunnelOffer } from './handshake';
import { createChallenge, verifyAuth } from './handshake';
import type { HandshakeLimits } from './handshake-limiter';
import { createHandshakeLimiter } from './handshake-limiter';
import type { HandshakeFailure } from './reject-mapping';
import { toWireRejection } from './reject-mapping';
import type { SessionTable } from './session-table';
import type { TunnelSession, TunnelTransport } from './tunnel-session';
import { createTunnelSession } from './tunnel-session';

/** One upgraded WebSocket: text messages during the handshake, binary frames after `ready`. */
export interface TunnelConnection {
    readonly transport: TunnelTransport;
    sendText(text: string): void;
}

/** What the WebSocket adapter reports for an attached connection. */
export interface ConnectionEvents {
    text(text: string): void;
    binary(message: Uint8Array): void;
    closed(code: number): void;
}

/** A TCP connection the endpoint admitted, from accept until it closes. */
export interface PendingConnection {
    /** The WebSocket upgrade on `TUNNEL_PATH` succeeded. Call at most once. */
    attach(connection: TunnelConnection): ConnectionEvents;
    /** The TCP socket closed, at any stage; idempotent. */
    socketClosed(): void;
}

export interface TunnelEndpointLimits extends HandshakeLimits {
    /** Counted from TCP accept to `ready`, so a slow TLS client cannot hold a slot. */
    readonly handshakeTimeoutMs: number;
    readonly maxTunnelsPerIp: number;
}

export interface TunnelEndpointOptions {
    readonly relayId: RelayId;
    readonly engineDomain: Hostname;
    readonly offer: RelayTunnelOffer;
    readonly registry: EngineRegistry;
    readonly dns: DnsResolver;
    readonly random: Random;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly limits: TunnelEndpointLimits;
    readonly table: SessionTable<TunnelSession>;
}

export interface TunnelEndpoint {
    /**
     * At TCP accept, or when the listener hands the socket over: `acceptedAtMs` (on this endpoint's clock) is when TCP
     * accepted it, so time spent before the hand-off counts against the deadline. `null`: drop the socket now.
     * `abandon` runs if the handshake deadline passes before the upgrade; the caller then destroys the socket.
     */
    accept(ip: string, abandon: () => void, acceptedAtMs?: number): PendingConnection | null;
    /** Refuses new connections and closes every tunnel with `SHUTTING_DOWN`, so engines reconnect to a peer at once. */
    shutdown(): void;
}

type Phase =
    | { readonly kind: 'tcp' }
    | { readonly kind: 'awaiting-auth'; readonly connection: TunnelConnection; readonly challenge: TunnelChallenge }
    | { readonly kind: 'verifying'; readonly connection: TunnelConnection; readonly controller: AbortController }
    | { readonly kind: 'ready'; readonly session: TunnelSession }
    | { readonly kind: 'ended' };

type HandshakePhase = Extract<Phase, { readonly kind: 'awaiting-auth' | 'verifying' }>;

interface Live {
    phase: Phase;
    readonly abandon: () => void;
    shutDown(): void;
}

/**
 * The server side of C-02's handshake for each connection: admission at TCP accept, `challenge`, `auth`
 * verification, `ready` or `reject`, then an authenticated session in the table.
 */
export function createTunnelEndpoint(options: TunnelEndpointOptions): TunnelEndpoint {
    const { relayId, engineDomain, offer, registry, dns, random, clock, logger, limits, table } = options;
    const limiter = createHandshakeLimiter(limits);
    const live = new Set<Live>();
    let stopping = false;

    return {
        accept(ip, abandon, acceptedAtMs = clock.nowMs()) {
            if (stopping) return null;
            const slot = limiter.admit(ip);
            if (slot === null) return null;
            // Hoisted functions below cannot see the narrowing of `slot`.
            const admission = slot;
            const state: Live = { phase: { kind: 'tcp' }, abandon, shutDown };
            live.add(state);
            const cancelDeadline = clock.setTimeout(
                onDeadline,
                acceptedAtMs + limits.handshakeTimeoutMs - clock.nowMs(),
            );

            function settle(phase: Phase): void {
                state.phase = phase;
                cancelDeadline();
                admission.release();
                if (phase.kind === 'ended') live.delete(state);
            }

            function fail(connection: TunnelConnection, failure: HandshakeFailure, engineId?: EngineId): void {
                if (state.phase.kind === 'verifying') state.phase.controller.abort();
                settle({ kind: 'ended' });
                const wire = toWireRejection(failure);
                if (wire.message !== null) connection.sendText(JSON.stringify(wire.message));
                connection.transport.close(wire.closeCode, '');
                logger.warn('tunnel.rejected', {
                    ...(engineId === undefined ? {} : { engineId }),
                    engineIp: ip,
                    relayId,
                    reason: failure,
                    closeCode: wire.closeCode,
                });
            }

            function onDeadline(): void {
                const { phase } = state;
                if (phase.kind === 'tcp') {
                    settle({ kind: 'ended' });
                    abandon();
                } else {
                    // `settle` cancels the deadline, so it fires only before `ready`.
                    fail((phase as HandshakePhase).connection, 'timeout');
                }
            }

            function shutDown(): void {
                const { phase } = state;
                if (phase.kind === 'ready') {
                    phase.session.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
                } else if (phase.kind === 'tcp') {
                    settle({ kind: 'ended' });
                    abandon();
                } else {
                    // Ended connections leave the live set, so this is a handshake in progress.
                    const handshake = phase as HandshakePhase;
                    if (handshake.kind === 'verifying') handshake.controller.abort();
                    settle({ kind: 'ended' });
                    handshake.connection.transport.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN, '');
                }
            }

            async function verify(text: string, connection: TunnelConnection, challenge: TunnelChallenge) {
                const controller = new AbortController();
                state.phase = { kind: 'verifying', connection, controller };
                const outcome = await verifyAuth({
                    auth: text,
                    challenge,
                    registry,
                    dns,
                    engineDomain,
                    logger,
                    signal: controller.signal,
                }).catch(() => null);
                // Every path that ends a handshake while it verifies (deadline, close, shutdown) aborts it and settles.
                if (controller.signal.aborted) return;
                if (outcome === null) {
                    fail(connection, 'registry-unavailable');
                    return;
                }
                if (outcome.kind === 'rejected') {
                    fail(connection, outcome.reason, outcome.engineId);
                    return;
                }
                const { engineId, hostnames, protocolVersion, features } = outcome;
                const ready = TunnelReady.parse({ v: 1, type: 'ready', protocolVersion, features, hostnames });
                const session = createTunnelSession({
                    engineId,
                    remoteIp: ip,
                    protocolVersion,
                    features,
                    transport: connection.transport,
                    onClosed(closeCode) {
                        settle({ kind: 'ended' });
                        table.remove(session);
                        logger.info('tunnel.disconnected', { engineId, engineIp: ip, relayId, closeCode });
                    },
                });
                settle({ kind: 'ready', session });
                connection.sendText(JSON.stringify(ready));
                table.register(session, hostnames);
                logger.info('tunnel.connected', { engineId, engineIp: ip, relayId });
            }

            return {
                attach(connection) {
                    if (state.phase.kind !== 'tcp') {
                        // The deadline or a shutdown ended it while the upgrade completed.
                        connection.transport.close(
                            stopping ? TUNNEL_CLOSE_CODE.SHUTTING_DOWN : TUNNEL_CLOSE_CODE.AUTH_FAILED,
                            '',
                        );
                    } else if (admission.verdict === 'rate-limited' || table.countByIp(ip) >= limits.maxTunnelsPerIp) {
                        fail(connection, 'rate-limited');
                    } else {
                        const { challenge } = createChallenge(random, relayId, offer);
                        state.phase = { kind: 'awaiting-auth', connection, challenge };
                        connection.sendText(JSON.stringify(challenge));
                    }
                    return {
                        text(text) {
                            const { phase } = state;
                            if (phase.kind === 'awaiting-auth') void verify(text, phase.connection, phase.challenge);
                            else if (phase.kind === 'verifying') fail(phase.connection, 'malformed');
                            else if (phase.kind === 'ready') phase.session.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                        },
                        binary(message) {
                            const { phase } = state;
                            if (phase.kind === 'ready') phase.session.receive(message);
                            else if (phase.kind === 'awaiting-auth' || phase.kind === 'verifying') {
                                fail(phase.connection, 'malformed');
                            }
                        },
                        closed(code) {
                            const { phase } = state;
                            if (phase.kind === 'ready') phase.session.transportClosed(code);
                            else if (phase.kind !== 'ended') {
                                if (phase.kind === 'verifying') phase.controller.abort();
                                settle({ kind: 'ended' });
                            }
                        },
                    };
                },
                socketClosed() {
                    // Once upgraded, the WebSocket's own close event reports the connection, with its close code.
                    if (state.phase.kind === 'tcp') settle({ kind: 'ended' });
                },
            };
        },
        shutdown() {
            stopping = true;
            for (const state of [...live]) state.shutDown();
        },
    };
}
