import { fail } from '../../../src/index';
import { startRegisteredEngine } from '../../fakes/dashboard';
import type { PlatformCheck, PlatformSuite } from '../../harness/platform';
import { TUNNEL_CHECK_RUNS } from '../../tunnel/checks';
import type { TunnelTiming } from '../../tunnel/runtime';
import { CONTRACT_TIMING } from '../../tunnel/runtime';
import { startTunnelRelay } from '../../tunnel/tunnel-relay';

export const TUNNEL_SUITE_ID = 'tunnel';
const SUITE = TUNNEL_SUITE_ID;

/** Relays per check: the scripted one, one that must keep its tunnel meanwhile, and one more to prove "every". */
const RELAYS_PER_CHECK = 3;

/** One tunnel check as engine teams track it. */
export interface TunnelCheckSpec {
    readonly id: string;
    readonly suite: typeof TUNNEL_SUITE_ID;
    readonly title: string;
}

/** In a stable order; each check gets its own relay and engine, so the order changes no outcome. */
export const TUNNEL_CHECKS: readonly TunnelCheckSpec[] = [
    {
        id: 'tunnel.dial.websocket-upgrade',
        suite: SUITE,
        title: 'The engine upgrades to a WebSocket on TUNNEL_PATH with the ptbk-tunnel subprotocol',
    },
    {
        id: 'tunnel.dial.every-relay',
        suite: SUITE,
        title: 'Exactly one ready tunnel to every relay in the list; a relay that stalls holds up no other',
    },
    {
        id: 'tunnel.auth.signature-verifies',
        suite: SUITE,
        title: "auth is strict, names the engine's own ID and verifies with verifyTunnelAuth, in time",
    },
    {
        id: 'tunnel.auth.fresh-nonce',
        suite: SUITE,
        title: "Each connection's auth signs that connection's nonce and verifies against no other challenge",
    },
    {
        id: 'tunnel.auth.version-signed',
        suite: SUITE,
        title: 'The auth signature verifies only over the version the engine sent',
    },
    {
        id: 'tunnel.auth.list-encoding',
        suite: SUITE,
        title: "Unsorted version and feature lists in challenge still get an auth that C-02's verifyTunnelAuth accepts",
    },
    {
        id: 'tunnel.stream.tls-through-tunnel',
        suite: SUITE,
        title: 'TLS 1.3 through a stream with the default hostname as SNI, then GET /api/v1/engine answers',
    },
    {
        id: 'tunnel.stream.unknown-sni-refused',
        suite: SUITE,
        title: 'A ClientHello for an unknown hostname or without SNI gets no certificate',
    },
    {
        id: 'tunnel.stream.concurrent',
        suite: SUITE,
        title: 'Many streams at once on one tunnel each complete TLS and an HTTP request',
    },
    {
        id: 'tunnel.flow.send-window',
        suite: SUITE,
        title: 'The engine never sends DATA beyond its credit and finishes once WINDOW grants more',
    },
    {
        id: 'tunnel.flow.grants-credit',
        suite: SUITE,
        title: 'The engine grants WINDOW credit as it reads, so more than the initial window can reach it',
    },
    {
        id: 'tunnel.stream.close-handling',
        suite: SUITE,
        title: 'The engine sends CLOSE when its side ends, and never sends on a stream the relay closed',
    },
    {
        id: 'tunnel.frames.ignorable-ignored',
        suite: SUITE,
        title: 'Frames with the ignorable flag and an unknown code are dropped; the tunnel and its streams carry on',
    },
    {
        id: 'tunnel.frames.valid-from-engine',
        suite: SUITE,
        title: 'Every frame the engine sends is a v1 frame with at most MAX_FRAME_PAYLOAD_BYTES of payload',
    },
    {
        id: 'tunnel.liveness.ping',
        suite: SUITE,
        title: 'A WebSocket ping at least every PING_INTERVAL_MS on a ready tunnel',
    },
    {
        id: 'tunnel.auth.wrong-relay-refused',
        suite: SUITE,
        title: 'A challenge naming another relay gets no auth',
    },
    {
        id: 'tunnel.negotiation.downgrade-refused',
        suite: SUITE,
        title: 'A ready with a lower version, a missing or an extra feature makes the engine close with PROTOCOL_ERROR',
    },
    {
        id: 'tunnel.handshake.invalid-message-refused',
        suite: SUITE,
        title: 'An invalid challenge, a frame before ready or a text message after it closes with PROTOCOL_ERROR',
    },
    {
        id: 'tunnel.frames.unknown-type-refused',
        suite: SUITE,
        title: 'An unknown frame code without the ignorable flag, or a v1 code with it, closes with PROTOCOL_ERROR',
    },
    {
        id: 'tunnel.frames.malformed-refused',
        suite: SUITE,
        title: 'A malformed frame closes the tunnel with PROTOCOL_ERROR; the engine survives and reconnects',
    },
    {
        id: 'tunnel.frames.stream-id-rules',
        suite: SUITE,
        title: 'A duplicate OPEN, a reused stream ID or a frame for a stream never opened closes with PROTOCOL_ERROR',
    },
    {
        id: 'tunnel.dial.relay-certificate-verified',
        suite: SUITE,
        title: 'A relay certificate for another name, from an untrusted CA or expired gets no WebSocket upgrade',
    },
    {
        id: 'tunnel.reconnect.after-close',
        suite: SUITE,
        title: 'After SHUTTING_DOWN the engine is back soon; after any other close or a lost connection it reconnects',
    },
    {
        id: 'tunnel.reconnect.relay-restart',
        suite: SUITE,
        title: 'After a relay restart the tunnel is back within 10 s (plus a margin)',
    },
    {
        id: 'tunnel.reconnect.after-reject',
        suite: SUITE,
        title: 'Every reject reason, with its close code (1013 for rate-limited), is followed by a reconnect',
    },
    {
        id: 'tunnel.reconnect.backoff',
        suite: SUITE,
        title: 'Consecutive failed attempts back off: no tight reconnect loop',
    },
    {
        id: 'tunnel.reconnect.replaced-no-loop',
        suite: SUITE,
        title: 'After REPLACED the engine does not reconnect in a loop',
    },
    {
        id: 'tunnel.proxy.connect',
        suite: SUITE,
        title: 'HTTPS_PROXY tunnels through CONNECT with the relay certificate still verified; NO_PROXY bypasses it',
    },
];

export interface TunnelSuiteOptions {
    /** The contract's timing by default; the self-test never shortens it for a real engine. */
    readonly timing?: TunnelTiming;
}

/**
 * Acting as the relays the engine dials (tunnel-client.md). Every check starts a fake relay serving three relay
 * hostnames, an engine registered with the fake dashboard whose `PTBK_RELAYS` names them, and waits until every relay
 * has a ready tunnel before it scripts anything.
 */
export function createTunnelSuite(options: TunnelSuiteOptions = {}): PlatformSuite {
    const timing = options.timing ?? CONTRACT_TIMING;
    return {
        id: SUITE,
        checks: TUNNEL_CHECKS.map((spec): PlatformCheck => {
            const run = TUNNEL_CHECK_RUNS[spec.id];
            if (run === undefined) throw new Error(`no implementation for ${spec.id}`);
            return {
                ...spec,
                // Waits like the ping interval, a run of backoffs or a restart under a proxy take a while.
                timeoutMs: (expectations) => expectations.startTimeoutMs + 4 * timing.reconnectMs + timing.pingMs,
                async run(ctx) {
                    const relay = await startTunnelRelay(ctx, { relays: RELAYS_PER_CHECK, timing });
                    const registered = await startRegisteredEngine(ctx, { env: relay.env });
                    const endpoint = await relay.endpointFor(registered);
                    const missing = await relay.runtime.waitAllReady(timing.reconnectMs, ctx.signal);
                    if (missing.length > 0) fail(`no ready tunnel to ${missing.join(', ')} after the engine started`);
                    const target = ctx.engineTarget(registered.engine, endpoint);
                    return run({
                        runtime: relay.runtime,
                        signal: ctx.signal,
                        session: () => (target === null ? Promise.resolve(null) : target.session({ kind: 'owner' })),
                    });
                },
            };
        }),
    };
}

export const TUNNEL_SUITE: PlatformSuite = createTunnelSuite();
