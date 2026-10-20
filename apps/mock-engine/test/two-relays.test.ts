import { createHash } from 'node:crypto';

import type { EngineId } from '@ptbk/protocol';
import { EngineVersion, Hostname, RelayId, defaultHostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryIdentityStore } from '../src/adapters/memory-identity-store';
import type { TunnelDuplex } from '../src/adapters/tunnel-duplex';
import { createWsRelayDialer } from '../src/adapters/ws-relay-dialer';
import type { MockEngineConfig } from '../src/app/config';
import { startMockEngine } from '../src/app/start-mock-engine';
import { BACKOFF_CAP_MS } from '../src/domain/tunnel/backoff';
import type { RelayTarget } from '../src/domain/tunnel/relay-target';
import { createFakeClock } from '../src/testing/fake-clock';
import type { FakeRelay } from '../src/testing/fake-relay';
import { startFakeRelay } from '../src/testing/fake-relay';
import { createMemoryLogger } from '../src/testing/memory-logger';
import { createRelayStreamPeer } from '../src/testing/relay-stream-peer';
import { createSeededRandom } from '../src/testing/seeded-random';
import { lookupLoopback, trackLinkStates } from '../src/testing/test-hosts';
import { createTestCa } from '../src/testing/test-pki';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const RELAY_A = RelayId.parse('relay-a.ptbk.test');
const RELAY_B = RelayId.parse('relay-b.ptbk.test');
const ca = createTestCa('M-01 test CA');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
    const identityStore = createMemoryIdentityStore();
    const identity = await identityStore.loadOrCreate();
    const hostname = defaultHostname(identity.engineId, ENGINE_DOMAIN);
    const registry = (engineId: EngineId) =>
        engineId === identity.engineId ? { publicKey: identity.publicKey, hostnames: [hostname] } : undefined;
    const certificates = new Map([RELAY_A, RELAY_B].map((relayId) => [relayId, ca.issue([relayId])]));

    async function startRelay(relayId: RelayId, port = 0): Promise<FakeRelay> {
        const tls = certificates.get(relayId);
        if (tls === undefined) throw new Error('no certificate');
        const relay = await startFakeRelay({ relayId, tls, registry, port });
        cleanups.push(() => relay.close());
        return relay;
    }

    const relays = { a: await startRelay(RELAY_A), b: await startRelay(RELAY_B) };
    const targets: RelayTarget[] = [
        { url: relays.a.url, relayId: RELAY_A, port: relays.a.port },
        { url: relays.b.url, relayId: RELAY_B, port: relays.b.port },
    ];
    const config: MockEngineConfig = {
        mode: 'tunnel',
        dataDir: '/unused',
        relays: targets,
        engineDomain: ENGINE_DOMAIN,
        engineVersion: EngineVersion.parse('0.1.0'),
        proxy: null,
        extraCaFile: null,
        logLevel: 'info',
    };
    const clock = createFakeClock(Date.now());
    const logger = createMemoryLogger();
    const states = trackLinkStates();
    const engine = await startMockEngine(config, {
        logger,
        clock,
        random: createSeededRandom(11),
        identityStore,
        dialer: createWsRelayDialer({ clock, proxy: null, ca: [ca.certPem], lookup: lookupLoopback }),
        onLinkState: states.onLinkState,
    });
    cleanups.push(() => engine.close());
    return { identity, hostname, relays, engine, clock, logger, states, startRelay };
}

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

describe('two relays (in-test relay speaking C-02 over TLS; R-03 does not exist yet)', () => {
    it('reaches ready on both, keeps one when the other dies, and reconnects to it within 10 s', async () => {
        const ctx = await setup();
        await ctx.states.next(RELAY_A, 'ready');
        await ctx.states.next(RELAY_B, 'ready');
        const sessionA = await ctx.relays.a.waitForSession();
        const sessionB = await ctx.relays.b.waitForSession();
        expect(sessionA.engineId).toBe(ctx.identity.engineId);
        expect(sessionB.ready.hostnames).toEqual([ctx.hostname]);

        await ctx.relays.a.kill();
        await ctx.states.next(RELAY_A, 'backoff');
        expect(ctx.states.latest(RELAY_B)?.kind).toBe('ready');
        expect(ctx.relays.b.sessions()).toBe(1);

        // While relay A is down, attempts fail for real (connection refused) and the backoff grows.
        for (let failed = 0; failed < 3; failed++) {
            const backoff = ctx.states.latest(RELAY_A);
            if (backoff?.kind !== 'backoff') throw new Error('expected backoff');
            ctx.clock.advance(backoff.delayMs);
            await ctx.states.next(RELAY_A, 'connecting');
            await ctx.states.next(RELAY_A, 'backoff');
        }
        expect(ctx.logger.entries.filter((entry) => entry.event === 'tunnel.dial-failed').length).toBe(3);

        const restarted = await ctx.startRelay(RELAY_A, ctx.relays.a.port);
        let elapsedMs = 0;
        while (ctx.states.latest(RELAY_A)?.kind !== 'ready') {
            const state = ctx.states.latest(RELAY_A);
            if (state?.kind === 'backoff') {
                ctx.clock.advance(state.delayMs);
                elapsedMs += state.delayMs;
            }
            await ctx.states.next(RELAY_A, 'ready', 'backoff');
        }
        expect(elapsedMs).toBeLessThanOrEqual(BACKOFF_CAP_MS);
        expect((await restarted.waitForSession()).engineId).toBe(ctx.identity.engineId);
        expect(ctx.states.latest(RELAY_B)?.kind).toBe('ready');
        expect(ctx.relays.b.connections()).toBe(1);
    });

    it('carries a stream over a real tunnel with WINDOW credit in both directions', async () => {
        const ctx = await setup();
        ctx.engine.onStream((duplex: TunnelDuplex) => {
            duplex.on('error', () => undefined);
            duplex.pipe(duplex);
        });
        const session = await ctx.relays.b.waitForSession();
        const peer = createRelayStreamPeer({
            send: (bytes) => {
                session.sendBinary(bytes);
            },
        });
        session.onBinary((bytes) => {
            peer.receive(bytes);
        });
        const stream = peer.open({ family: 4, address: Uint8Array.of(198, 51, 100, 23), port: 61_000 });

        // Several windows' worth, so the echo only completes if credit flows back both ways.
        const payload = createSeededRandom(5).bytes(1_500_000);
        await stream.write(payload);
        await stream.waitForBytes(payload.length);
        expect(sha256(stream.received())).toBe(sha256(payload));
        expect(peer.errors()).toEqual([]);
    });
});
