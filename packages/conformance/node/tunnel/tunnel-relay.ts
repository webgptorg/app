import { RelayId, decodeBase64Url, defaultHostname } from '@ptbk/protocol';

import type { RegisteredEngine } from '../fakes/dashboard';
import { LOOPBACK_DOMAIN } from '../harness/loopback';
import type { LaunchEnv } from '../harness/launch-env';
import type { Closable, EngineApiEndpoint, PlatformCheckContext } from '../harness/platform';
import type { FakeRelay } from '../fake-relay/fake-relay';
import { startFakeRelay } from '../fake-relay/fake-relay';
import { connectToEngine, createTunnelFetch } from './engine-fetch';
import type { TunnelEngine, TunnelTiming } from './runtime';
import { CONTRACT_TIMING, TunnelRuntime } from './runtime';

export interface TunnelRelayOptions {
    /** How many relays the engine gets in `PTBK_RELAYS` (default 2), all served by one fake relay on loopback. */
    readonly relays?: number;
    readonly timing?: TunnelTiming;
}

export interface TunnelRelay extends Closable {
    readonly relay: FakeRelay;
    readonly runtime: TunnelRuntime;
    /** Merge into the engine's launch env before it starts. */
    readonly env: LaunchEnv;
    /** Once the engine registered: waits for a ready tunnel, then gives the engine API on the engine's own origin. */
    endpointFor(registered: RegisteredEngine): Promise<EngineApiEndpoint>;
}

/** Relay hostnames under the loopback domain, which the harness CA may vouch for. */
export function relayIdsFor(count: number): RelayId[] {
    return Array.from({ length: count }, (_, index) =>
        RelayId.parse(`relay-${String(index + 1)}.relays.${LOOPBACK_DOMAIN}`),
    );
}

/**
 * `PTBK_RELAYS` in the launch contract's form, `wss://<relay hostname>[:port]`. No path: the engine dials TUNNEL_PATH
 * itself, and an engine that parses the variable as strictly as the contract writes it refuses anything else.
 */
export function relaysOverride(relay: Pick<FakeRelay, 'relayIds' | 'port'>): string {
    return relay.relayIds.map((relayId) => `wss://${relayId}:${String(relay.port)}`).join(',');
}

/** The engine as the tunnel suite drives it, from what the harness knows after registration. */
export function tunnelEngineOf(ctx: PlatformCheckContext, registered: RegisteredEngine): TunnelEngine {
    const key = decodeBase64Url(registered.identity.enginePublicKey);
    if (key.kind === 'invalid') throw new Error('the registration carried no valid public key');
    const { engine } = registered;
    return {
        enginePublicKey: key.bytes,
        restart: (patch) => engine.restart(patch),
        running: () => engine.running,
        logs: () => engine.logs(),
        certificateAuthority: () => ctx.engineCertificateAuthority(engine),
    };
}

/**
 * A fake relay for one check, closed after it. The engine dials it through `PTBK_RELAYS` (an operator override of the
 * registration's relays, so the suite can choose loopback names and a port) and verifies its certificate against the
 * harness CA it trusts through `NODE_EXTRA_CA_CERTS`.
 */
export async function startTunnelRelay(
    ctx: PlatformCheckContext,
    options: TunnelRelayOptions = {},
): Promise<TunnelRelay> {
    const timing = options.timing ?? CONTRACT_TIMING;
    const relay = await startFakeRelay({ relayIds: relayIdsFor(options.relays ?? 2), trustedCa: ctx.ca });
    const runtime = new TunnelRuntime(relay, ctx.engineDomain, timing);
    const tunnelRelay: TunnelRelay = {
        relay,
        runtime,
        env: { PTBK_RELAYS: relaysOverride(relay) },
        async endpointFor(registered) {
            runtime.attach(tunnelEngineOf(ctx, registered));
            const hostname = defaultHostname(registered.identity.engineId, ctx.engineDomain);
            const firstReady = async () => {
                const ready = await runtime.waitReady(null, timing.reconnectMs, ctx.signal);
                if (ready === null)
                    throw new Error(`no relay had a ready tunnel within ${String(timing.reconnectMs)} ms`);
                return ready;
            };
            await firstReady();
            const engine = {
                hostname,
                tunnel: firstReady,
                certificateAuthority: () => ctx.engineCertificateAuthority(registered.engine),
                handshakeMs: timing.requestMs,
            };
            return {
                baseUrl: new URL(`https://${hostname}`),
                fetch: createTunnelFetch(engine),
                connect: () => connectToEngine(engine),
            };
        },
        close: () => relay.close(),
    };
    return ctx.use(tunnelRelay);
}
