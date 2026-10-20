import type {
    EngineVersion,
    Hostname,
    TunnelAuth,
    TunnelChallenge,
    TunnelFeature,
    TunnelReady,
    TunnelRejectReason,
} from '@ptbk/protocol';
import {
    AUTH_TIMEOUT_MS,
    TUNNEL_CLOSE_CODE,
    checkTunnelReady,
    encodeFrame,
    parseRelayMessage,
    signTunnelAuth,
} from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { EngineIdentity } from '../identity/engine-identity';
import { signerOf } from '../identity/engine-identity';
import type { Logger } from '../logger';
import type { Random } from '../random';
import { attemptAfterReady, nextDelayMs, reconnectAfterClose, shuttingDownDelayMs } from './backoff';
import type { RelayConnection, RelayDialer, DialResult } from './relay-dialer';
import type { RelayTarget } from './relay-target';
import type { StreamMux } from './stream-mux';
import { createStreamMux } from './stream-mux';
import type { StreamEvents, TunnelStream } from './tunnel-stream';

/**
 * From the WebSocket opening to `ready`. The relay allows `AUTH_TIMEOUT_MS` for our `auth` and then looks us up in
 * its registry, which may take a few seconds more; past this, the relay is not going to answer.
 */
export const HANDSHAKE_TIMEOUT_MS = AUTH_TIMEOUT_MS + 5_000;
/** How long `stop` waits for the relay to acknowledge the close before giving up on it. */
export const STOP_TIMEOUT_MS = 3_000;

const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_GOING_AWAY = 1001;

/** What the relay accepted in `ready`, after the engine checked it against the signed lists. */
export interface TunnelSession {
    readonly protocolVersion: number;
    readonly features: readonly TunnelFeature[];
    readonly hostnames: readonly Hostname[];
}

export type RelayLinkState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'connecting'; readonly attempt: number }
    | { readonly kind: 'handshaking'; readonly attempt: number }
    | { readonly kind: 'ready'; readonly session: TunnelSession }
    | { readonly kind: 'backoff'; readonly attempt: number; readonly delayMs: number }
    | { readonly kind: 'stopped'; readonly reason: 'requested' | 'replaced' };

/** The protocol versions and feature flags this engine advertises in `auth` (ADR 0010 §2). */
export interface TunnelOfferConfig {
    readonly protocolVersions: readonly number[];
    readonly features: readonly TunnelFeature[];
}

export interface RelayLinkDeps {
    readonly relay: RelayTarget;
    readonly identity: EngineIdentity;
    /** `TunnelAuth.version`: the engine software version, signed with the rest of `auth`. */
    readonly engineVersion: EngineVersion;
    readonly offer: TunnelOfferConfig;
    /** `<engineId>.<engine domain>`; a relay that does not accept it is logged as a warning. */
    readonly defaultHostname: Hostname;
    readonly dialer: RelayDialer;
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
    /** A browser connection the relay opened; returns the consumer's events. */
    readonly onStream: (stream: TunnelStream) => StreamEvents;
    readonly onStateChange?: (state: RelayLinkState) => void;
}

/** One relay's tunnel: `idle → connecting → handshaking → ready → backoff → connecting …`, until stopped. */
export interface RelayLink {
    readonly relay: RelayTarget;
    state(): RelayLinkState;
    start(): void;
    /** Closes the tunnel with 1001 (going away) and stops reconnecting. Resolves once the socket closed. */
    stop(): Promise<void>;
}

type Phase =
    | { readonly kind: 'dialing' }
    | { readonly kind: 'await-challenge'; readonly connection: RelayConnection }
    | { readonly kind: 'signing'; readonly connection: RelayConnection; readonly challenge: TunnelChallenge }
    | {
          readonly kind: 'await-ready';
          readonly connection: RelayConnection;
          readonly challenge: TunnelChallenge;
          readonly auth: TunnelAuth;
      }
    | {
          readonly kind: 'ready';
          readonly connection: RelayConnection;
          readonly mux: StreamMux;
          readonly readyAtMs: number;
      }
    | { readonly kind: 'ended' };

/** One connection attempt. Events from an attempt that is no longer current are stale and ignored. */
interface Attempt {
    readonly number: number;
    readonly abort: AbortController;
    phase: Phase;
    cancelHandshakeTimer: () => void;
    onSocketClosed: (() => void) | null;
}

function noop(): void {
    // Placeholder for a timer that is not running.
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'unknown';
}

export function createRelayLink(deps: RelayLinkDeps): RelayLink {
    const { relay, clock, logger, random } = deps;
    const url = relay.url;
    let state: RelayLinkState = { kind: 'idle' };
    let current: Attempt | null = null;
    let failures = 0;
    let cancelRetry = noop;

    function setState(next: RelayLinkState): void {
        state = next;
        const detail =
            next.kind === 'connecting' || next.kind === 'handshaking'
                ? { attempt: next.attempt }
                : next.kind === 'backoff'
                  ? { attempt: next.attempt, delayMs: next.delayMs }
                  : next.kind === 'stopped'
                    ? { reason: next.reason }
                    : {};
        logger.info('tunnel.state', { relay: url, state: next.kind, ...detail });
        deps.onStateChange?.(next);
    }

    function connect(): void {
        cancelRetry = noop;
        const attempt: Attempt = {
            number: failures + 1,
            abort: new AbortController(),
            phase: { kind: 'dialing' },
            cancelHandshakeTimer: noop,
            onSocketClosed: null,
        };
        current = attempt;
        setState({ kind: 'connecting', attempt: attempt.number });
        deps.dialer
            .dial(
                relay,
                {
                    onText: (text) => {
                        onText(attempt, text);
                    },
                    onBinary: (bytes) => {
                        onBinary(attempt, bytes);
                    },
                    onClose: (code) => {
                        onClose(attempt, code);
                    },
                },
                attempt.abort.signal,
            )
            .then(
                (result) => {
                    onDialed(attempt, result);
                },
                (error: unknown) => {
                    // The dialer reports expected failures as values; a rejection is a bug, so fail closed.
                    if (attempt !== current) return;
                    logger.error('tunnel.dial-error', {
                        relay: url,
                        attempt: attempt.number,
                        problem: errorName(error),
                    });
                    end(attempt, null);
                    retry('backoff');
                },
            );
    }

    function onDialed(attempt: Attempt, result: DialResult): void {
        if (attempt !== current) {
            if (result.kind === 'open') result.connection.close(WS_CLOSE_GOING_AWAY);
            return;
        }
        if (result.kind === 'failed') {
            const { failure } = result;
            logger.warn('tunnel.dial-failed', {
                relay: url,
                attempt: attempt.number,
                reason: failure.reason,
                ...('status' in failure ? { status: failure.status } : {}),
            });
            attempt.phase = { kind: 'ended' };
            retry('backoff');
            return;
        }
        attempt.phase = { kind: 'await-challenge', connection: result.connection };
        attempt.cancelHandshakeTimer = clock.setTimeout(() => {
            logger.warn('tunnel.handshake-timeout', { relay: url, attempt: attempt.number });
            fail(attempt, TUNNEL_CLOSE_CODE.AUTH_FAILED);
        }, HANDSHAKE_TIMEOUT_MS);
        setState({ kind: 'handshaking', attempt: attempt.number });
    }

    function onText(attempt: Attempt, text: string): void {
        if (attempt !== current || attempt.phase.kind === 'dialing') return;
        const parsed = parseRelayMessage(text);
        if (parsed.kind === 'invalid') {
            protocolError(attempt, 'invalid-message');
            return;
        }
        const message = parsed.message;
        const phase = attempt.phase;
        switch (message.type) {
            case 'challenge':
                if (phase.kind !== 'await-challenge') {
                    protocolError(attempt, 'unexpected-challenge');
                    return;
                }
                void answer(attempt, phase.connection, message);
                return;
            case 'ready':
                if (phase.kind !== 'await-ready') {
                    protocolError(attempt, 'unexpected-ready');
                    return;
                }
                accept(attempt, phase, message);
                return;
            case 'reject':
                if (phase.kind === 'ready') {
                    protocolError(attempt, 'unexpected-reject');
                    return;
                }
                rejected(attempt, message.reason);
                return;
        }
    }

    async function answer(attempt: Attempt, connection: RelayConnection, challenge: TunnelChallenge): Promise<void> {
        attempt.phase = { kind: 'signing', connection, challenge };
        let signing;
        try {
            signing = await signTunnelAuth(
                signerOf(deps.identity),
                challenge,
                {
                    version: deps.engineVersion,
                    protocolVersions: deps.offer.protocolVersions,
                    features: deps.offer.features,
                },
                { dialledRelayId: relay.relayId },
                attempt.abort.signal,
            );
        } catch (error) {
            if (attempt !== current) return;
            logger.error('tunnel.sign-failed', { relay: url, attempt: attempt.number, problem: errorName(error) });
            fail(attempt, TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            return;
        }
        // A reject, a protocol error or `stop` during signing all leave this attempt no longer current.
        if (attempt !== current) return;
        if (signing.kind === 'wrong-relay') {
            // Answering would hand this relay a signature another relay accepts; the claimed name is not logged.
            logger.warn('tunnel.wrong-relay', { relay: url, attempt: attempt.number });
            fail(attempt, TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            return;
        }
        attempt.phase = { kind: 'await-ready', connection, challenge, auth: signing.auth };
        connection.sendText(JSON.stringify(signing.auth));
    }

    function accept(attempt: Attempt, phase: Extract<Phase, { kind: 'await-ready' }>, ready: TunnelReady): void {
        if (checkTunnelReady(phase.challenge, phase.auth, ready).kind === 'negotiation-mismatch') {
            logger.warn('tunnel.downgrade-refused', {
                relay: url,
                attempt: attempt.number,
                protocolVersion: ready.protocolVersion,
                features: ready.features.join(','),
            });
            fail(attempt, TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            return;
        }
        attempt.cancelHandshakeTimer();
        const { connection } = phase;
        const mux = createStreamMux({
            sendFrame: (frame) => {
                connection.sendBinary(encodeFrame(frame));
            },
            onOpen: (stream) => deps.onStream(stream),
        });
        attempt.phase = { kind: 'ready', connection, mux, readyAtMs: clock.nowMs() };
        const session: TunnelSession = {
            protocolVersion: ready.protocolVersion,
            features: ready.features,
            hostnames: ready.hostnames,
        };
        logger.info('tunnel.ready', {
            relay: url,
            attempt: attempt.number,
            protocolVersion: session.protocolVersion,
            features: session.features.join(','),
            hostnames: session.hostnames.length,
        });
        if (!session.hostnames.includes(deps.defaultHostname)) {
            logger.warn('tunnel.default-hostname-missing', { relay: url });
        }
        setState({ kind: 'ready', session });
    }

    function rejected(attempt: Attempt, reason: TunnelRejectReason): void {
        logger.warn('tunnel.rejected', { relay: url, attempt: attempt.number, reason });
        end(attempt, WS_CLOSE_NORMAL);
        retry('backoff');
    }

    function onBinary(attempt: Attempt, bytes: Uint8Array): void {
        if (attempt !== current || attempt.phase.kind === 'dialing') return;
        if (attempt.phase.kind !== 'ready') {
            protocolError(attempt, 'frame-before-ready');
            return;
        }
        const received = attempt.phase.mux.receive(bytes);
        if (received.kind === 'protocol-error') protocolError(attempt, received.reason);
    }

    function onClose(attempt: Attempt, code: number): void {
        const waiter = attempt.onSocketClosed;
        attempt.onSocketClosed = null;
        waiter?.();
        if (attempt !== current) return;
        const phase = attempt.phase;
        logger.warn('tunnel.closed', { relay: url, attempt: attempt.number, code, phase: phase.kind });
        end(attempt, null);
        if (phase.kind !== 'ready') {
            // A relay that closes during the handshake (after a reject, or draining) is retried with normal backoff:
            // a fast retry here could loop against a relay that accepts and closes every connection.
            retry('backoff');
            return;
        }
        failures = attemptAfterReady(failures, clock.nowMs() - phase.readyAtMs);
        const reconnect = reconnectAfterClose(code);
        switch (reconnect.kind) {
            case 'stop':
                logger.error('tunnel.replaced', { relay: url });
                current = null;
                setState({ kind: 'stopped', reason: 'replaced' });
                return;
            case 'fast':
            case 'backoff':
                retry(reconnect.kind);
                return;
        }
    }

    function protocolError(attempt: Attempt, reason: string): void {
        logger.warn('tunnel.protocol-error', { relay: url, attempt: attempt.number, reason });
        fail(attempt, TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
    }

    function fail(attempt: Attempt, code: number): void {
        end(attempt, code);
        retry('backoff');
    }

    /** Ends `attempt` for good: no event from it is acted on again. `closeCode: null` when the socket is gone. */
    function end(attempt: Attempt, closeCode: number | null): void {
        const phase = attempt.phase;
        attempt.phase = { kind: 'ended' };
        attempt.cancelHandshakeTimer();
        attempt.abort.abort();
        if (phase.kind === 'ready') phase.mux.closeAll();
        if (closeCode !== null && phase.kind !== 'dialing' && phase.kind !== 'ended') phase.connection.close(closeCode);
    }

    function retry(kind: 'backoff' | 'fast'): void {
        current = null;
        const delayMs = kind === 'fast' ? shuttingDownDelayMs(random) : nextDelayMs(failures, random);
        if (kind === 'backoff') failures++;
        setState({ kind: 'backoff', attempt: failures, delayMs });
        cancelRetry = clock.setTimeout(connect, delayMs);
    }

    return {
        relay,
        state: () => state,
        start() {
            if (state.kind !== 'idle') return;
            connect();
        },
        async stop() {
            if (state.kind === 'stopped') return;
            cancelRetry();
            cancelRetry = noop;
            const attempt = current;
            current = null;
            setState({ kind: 'stopped', reason: 'requested' });
            if (attempt === null) return;
            const hasSocket = attempt.phase.kind !== 'dialing' && attempt.phase.kind !== 'ended';
            if (!hasSocket) {
                end(attempt, null);
                return;
            }
            await new Promise<void>((resolve) => {
                const cancelTimeout = clock.setTimeout(resolve, STOP_TIMEOUT_MS);
                attempt.onSocketClosed = () => {
                    cancelTimeout();
                    resolve();
                };
                end(attempt, WS_CLOSE_GOING_AWAY);
            });
        },
    };
}
