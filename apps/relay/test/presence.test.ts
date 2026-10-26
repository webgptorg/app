import type { EngineId } from '@ptbk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PRESENCE_DEBOUNCE_MS, PRESENCE_INTERVAL_MS } from '../src/domain/presence/presence-reporter';
import type { TestEngineClient } from '../src/testing/engine-client';
import type { TestEngine } from '../src/testing/engines';
import { createTestEngine } from '../src/testing/engines';
import type { FakeDashboard } from '../src/testing/fake-dashboard';
import type { RelayHarness } from '../src/testing/relay-harness';
import { startHarness } from '../src/testing/relay-harness';

/** R-07: the relay tells the dashboard which engines hold a ready tunnel, over real HTTP with the fake clock. */
describe('tunnel presence reports', () => {
    let relay: RelayHarness | undefined;

    afterEach(async () => {
        await relay?.close();
        relay = undefined;
    });

    async function start(): Promise<{ readonly harness: RelayHarness; readonly dashboard: FakeDashboard }> {
        relay = await startHarness({ viaDashboard: true });
        if (relay.dashboard === null) throw new Error('expected the fake dashboard');
        return { harness: relay, dashboard: relay.dashboard };
    }

    async function connected(harness: RelayHarness, engine: TestEngine): Promise<TestEngineClient> {
        harness.registry.set(engine.engineId, engine.entry);
        const client = harness.connect(engine);
        const challenge = await client.nextMessage();
        if (challenge.type !== 'challenge') throw new Error('expected a challenge');
        await client.authenticate(challenge);
        expect(await client.nextMessage()).toMatchObject({ type: 'ready' });
        return client;
    }

    const reported = (dashboard: FakeDashboard, index: number): readonly EngineId[] | undefined => {
        const text = dashboard.presence[index]?.text;
        return text === undefined ? undefined : (JSON.parse(text) as { engineIds: EngineId[] }).engineIds;
    };

    it('reports a ready tunnel within one debounce, and its closing in a later full report', async () => {
        const { harness, dashboard } = await start();
        const engine = await createTestEngine(140);
        const other = await createTestEngine(141);
        const client = await connected(harness, engine);
        await connected(harness, other);
        harness.clock.advance(PRESENCE_DEBOUNCE_MS);
        await vi.waitFor(() => {
            expect(dashboard.presence).toHaveLength(1);
        });
        expect(reported(dashboard, 0)).toEqual([engine.engineId, other.engineId].sort());
        expect(Object.keys(JSON.parse(dashboard.presence[0]?.text ?? '{}') as object)).toEqual(['v', 'engineIds']);

        client.ws.close();
        await vi.waitFor(() => {
            expect(harness.listener.sessions.byEngine(engine.engineId)).toBeUndefined();
        });
        await vi.waitFor(() => {
            if (dashboard.presence.length < 2) harness.clock.advance(1000);
            expect(reported(dashboard, 1)).toEqual([other.engineId]);
        });
        expect(dashboard.requests()).toBeGreaterThan(0);
    });

    it('keeps tunnels connected and routable while every report fails, and retries each interval', async () => {
        const { harness, dashboard } = await start();
        dashboard.setPresenceStatus(500);
        const engine = await createTestEngine(142);
        const client = await connected(harness, engine);
        let closed = false;
        void client.closed.then(() => {
            closed = true;
        });
        harness.clock.advance(PRESENCE_DEBOUNCE_MS);
        const failures = () => harness.logger.entries.filter((entry) => entry.event === 'presence.report-failed');
        await vi.waitFor(() => {
            expect(failures()).toHaveLength(1);
        });
        harness.clock.advance(PRESENCE_INTERVAL_MS);
        await vi.waitFor(() => {
            expect(failures()).toHaveLength(2);
        });
        expect(failures()[0]?.fields).toEqual({ status: 500 });
        expect(reported(dashboard, 1)).toEqual([engine.engineId]);
        expect(harness.listener.sessions.byHostname(engine.defaultHostname)?.engineId).toBe(engine.engineId);
        expect(closed).toBe(false);
    });

    it('sends nothing with the static registry, which has no dashboard', async () => {
        relay = await startHarness();
        const engine = await createTestEngine(143);
        await connected(relay, engine);
        relay.clock.advance(PRESENCE_INTERVAL_MS);
        expect(relay.dashboard).toBeNull();
        expect(relay.logger.entries.filter((entry) => entry.event.startsWith('presence.'))).toEqual([]);
    });
});
