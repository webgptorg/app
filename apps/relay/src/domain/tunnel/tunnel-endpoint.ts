import type { EngineId, Hostname, RelayId, TunnelChallenge } from '@ptbk/protocol';
import { TUNNEL_CLOSE_CODE, TunnelReady } from '@ptbk/protocol';

import type { CachedRegistry } from '../cached-registry';
import type { Clock } from '../clock';
import type { DnsResolver } from '../dns-resolver';
import { createTokenBucket } from '../limits/token-bucket';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics/catalog';
import { disconnectCode } from '../metrics/catalog';
import type { ReasonCounters, TunnelTerminationReason } from '../metrics/reason-counters';
import type { Random } from '../random';
import type { RelayTunnelOffer } from './handshake';
import { createChallenge, verifyAuth } from './handshake';
import type { HandshakeLimits } from './handshake-limiter';
import { createHandshakeLimiter } from './handshake-limiter';
import type { HandshakeFailure } from './reject-mapping';
import { toWireRejection } from './reject-mapping';
import type { SessionTable } from './session-table';
import type { TunnelSession, TunnelSessionLimits, TunnelTransport } from './tunnel-session';
import { createTunnelSession } from './tunnel-session';

/** How long a refused engine has to read `reject` and the close frame before its socket is destroyed. */
export const REJECT_LINGER_MS = 1_000;

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
    /** The TCP socket closed, at any stage; idempotent. Frees the connection's pending-handshake slot. */
    socketClosed(): void;
}

export interface TunnelEndpointLimits extends HandshakeLimits {
    /** Counted from TCP accept to `ready`, so a slow TLS client cannot hold a slot. */
    readonly handshakeTimeoutMs: number;
    readonly maxTunnelsPerIp: number;
    /**
     * `RELAY_REGISTRY_MISSES_PER_S`: handshakes per second, relay-wide, whose engine is not in the registry cache (also
     * the burst). Revalidation is not counted here; it is paced by its interval.
     */
    readonly registryMissesPerS: number;
    readonly session: TunnelSessionLimits;
}

export interface TunnelEndpointOptions {
    readonly relayId: RelayId;
    readonly engineDomain: Hostname;
    readonly offer: RelayTunnelOffer;
    readonly registry: Pick<CachedRegistry, 'lookup' | 'has'>;
    readonly dns: DnsResolver;
    readonly random: Random;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly limits: TunnelEndpointLimits;
    readonly table: SessionTable<TunnelSession>;
    readonly terminations: Pick<ReasonCounters<TunnelTerminationReason>, 'count'>;
    /** Connects, disconnects and refusals; never which engine or address. */
    readonly metrics: Metrics;
}

export interface TunnelEndpoint {
    /**
     * At TCP accept, or when the listener hands the socket over: `acceptedAtMs` (on this endpoint's clock) is when TCP
     * accepted it, so time spent before the hand-off counts against the deadline. `null`: drop the socket now.
     * `abandon` runs when the endpoint is done with the socket (the deadline passed before the upgrade, or a refused
     * engine had `REJECT_LINGER_MS` to read its `reject`); the caller then destroys it.
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
    const { relayId, engineDomain, offer, registry, dns, random, clock, logger, limits, table, terminations, metrics } =
        options;
    const limiter = createHandshakeLimiter(limits, clock);
    const misses = createTokenBucket({
        capacity: limits.registryMissesPerS,
        refillPerSecond: limits.registryMissesPerS,
        clock,
    });
    const admitLookup = (engineId: EngineId): boolean => registry.has(engineId) || misses.tryTake(1);
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
            let cancelLinger = (): void => undefined;

            // A handshake that ends keeps its slot until the socket is gone, so refused sockets still closing count
            // against the limits; only `ready` frees it early, since the tunnel is then counted per IP instead.
            function settle(phase: Phase): void {
                state.phase = phase;
                cancelDeadline();
                if (phase.kind === 'ready') admission.release();
                if (phase.kind === 'ended') live.delete(state);
            }

            function fail(connection: TunnelConnection, failure: HandshakeFailure, engineId?: EngineId): void {
                if (state.phase.kind === 'verifying') state.phase.controller.abort();
                settle({ kind: 'ended' });
                const wire = toWireRejection(failure);
                if (wire.message !== null) connection.sendText(JSON.stringify(wire.message));
                connection.transport.close(wire.closeCode, '');
                cancelLinger = clock.setTimeout(abandon, REJECT_LINGER_MS);
                metrics.count('ptbk_relay_tunnel_handshake_failures_total', { reason: failure });
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

            // Only a bug gets here (verification itself never throws), so nothing about the connection is trusted.
            function failed(connection: TunnelConnection, error: unknown): void {
                logger.error('tunnel.failed', { problem: error instanceof Error ? error.name : 'unknown' });
                terminations.count('failed');
                const { phase } = state;
                if (phase.kind === 'ready') {
                    phase.session.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                    return;
                }
                settle({ kind: 'ended' });
                connection.transport.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR, '');
                cancelLinger = clock.setTimeout(abandon, REJECT_LINGER_MS);
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
                    admitLookup,
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
                    clock,
                    limits: limits.session,
                    terminations,
                    onClosed(closeCode) {
                        settle({ kind: 'ended' });
                        table.remove(session);
                        metrics.count('ptbk_relay_tunnel_disconnects_total', { code: disconnectCode(closeCode) });
                        logger.info('tunnel.disconnected', { engineId, engineIp: ip, relayId, closeCode });
                    },
                });
                settle({ kind: 'ready', session });
                connection.sendText(JSON.stringify(ready));
                table.register(session, hostnames);
                metrics.count('ptbk_relay_tunnel_connects_total', {});
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
                            if (phase.kind === 'awaiting-auth') {
                                verify(text, phase.connection, phase.challenge).catch((error: unknown) => {
                                    failed(phase.connection, error);
                                });
                            } else if (phase.kind === 'verifying') fail(phase.connection, 'malformed');
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
                    cancelLinger();
                    admission.release();
                },
            };
        },
        shutdown() {
            stopping = true;
            for (const state of [...live]) state.shutDown();
        },
    };
}
