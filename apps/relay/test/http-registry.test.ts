import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TestEngineClient } from '../src/testing/engine-client';
import type { TestEngine } from '../src/testing/engines';
import { createTestEngine } from '../src/testing/engines';
import type { HarnessOptions, RelayHarness } from '../src/testing/relay-harness';
import { startHarness } from '../src/testing/relay-harness';

/** D-04: tunnels against the dashboard registry over real HTTP, with the fake clock driving cache and revalidation. */
describe('tunnels on the dashboard registry', () => {
    let relay: RelayHarness | undefined;

    afterEach(async () => {
        await relay?.close();
        relay = undefined;
    });

    async function start(options: HarnessOptions = {}): Promise<RelayHarness> {
        relay = await startHarness({ ...options, viaDashboard: true });
        return relay;
    }

    async function connected(harness: RelayHarness, engine: TestEngine): Promise<TestEngineClient> {
        const client = harness.connect(engine);
        const challenge = await client.nextMessage();
        if (challenge.type !== 'challenge') throw new Error('expected a challenge');
        await client.authenticate(challenge);
        expect(await client.nextMessage()).toMatchObject({ type: 'ready', hostnames: [engine.defaultHostname] });
        return client;
    }

    it('closes a connected tunnel with SUSPENDED within one TTL of its entry turning suspended', async () => {
        const harness = await start();
        const engine = await createTestEngine(120);
        harness.registry.set(engine.engineId, engine.entry);
        const client = await connected(harness, engine);
        harness.registry.set(engine.engineId, { ...engine.entry, status: 'suspended' });
        harness.clock.advance(harness.config.registry.ttlMs - 1);
        expect(harness.listener.sessions.byEngine(engine.engineId)).toBeDefined();
        harness.clock.advance(1);
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.SUSPENDED);
    });

    it('closes a tunnel whose engine the dashboard no longer knows with AUTH_FAILED', async () => {
        const harness = await start();
        const engine = await createTestEngine(121);
        harness.registry.set(engine.engineId, engine.entry);
        const client = await connected(harness, engine);
        harness.registry.delete(engine.engineId);
        harness.clock.advance(harness.config.registry.ttlMs);
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.AUTH_FAILED);
    });

    it('keeps a tunnel through a dashboard outage up to 24 h, then closes it and refuses it again', async () => {
        const harness = await start({ env: { RELAY_REGISTRY_TTL_S: '3600' } });
        const engine = await createTestEngine(122);
        harness.registry.set(engine.engineId, engine.entry);
        const client = await connected(harness, engine);
        harness.registry.setMode('unavailable');
        const staleRounds = (): number =>
            harness.logger.entries.filter((entry) => entry.event === 'registry.stale').length;
        for (let hour = 1; hour < 24; hour++) {
            harness.clock.advance(3_600_000);
            await vi.waitFor(() => {
                expect(staleRounds()).toBe(hour);
            });
        }
        expect(harness.listener.sessions.byEngine(engine.engineId)).toBeDefined();
        harness.clock.advance(3_600_000);
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.AUTH_FAILED);
        expect(harness.logger.entries).toContainEqual({
            level: 'error',
            event: 'registry.error',
            fields: { engineId: engine.engineId, kind: 'server-error' },
        });
        const again = harness.connect(engine);
        const challenge = await again.nextMessage();
        if (challenge.type !== 'challenge') throw new Error('expected a challenge');
        await again.authenticate(challenge);
        expect(await again.nextMessage()).toEqual({ v: 1, type: 'reject', reason: 'auth-failed' });
    });

    it('refuses a tunnel whose registry key is not the key that signed the auth with auth-failed', async () => {
        const harness = await start();
        const engine = await createTestEngine(123);
        const other = await createTestEngine(124);
        harness.registry.set(engine.engineId, other.entry);
        const client = harness.connect(engine);
        const challenge = await client.nextMessage();
        if (challenge.type !== 'challenge') throw new Error('expected a challenge');
        await client.authenticate(challenge);
        expect(await client.nextMessage()).toEqual({ v: 1, type: 'reject', reason: 'auth-failed' });
        expect((await client.closed).code).toBe(TUNNEL_CLOSE_CODE.AUTH_FAILED);
    });
});
