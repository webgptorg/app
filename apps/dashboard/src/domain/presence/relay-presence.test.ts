import type { EngineId } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createRegistryTestDeps } from '../../testing/test-registry';
import { createMemoryRelayPresenceStore } from '../../testing/memory-relay-presence-store';
import { presenceEngineIds } from '../../testing/relay-presence-store-contract';
import { PRESENCE_EXPIRY_MS, readReachableRelays, recordPresence } from './relay-presence';

const RELAY = 'relay-a.ptbk.test';

function setup() {
    const { clock, logger } = createRegistryTestDeps();
    const relayPresence = createMemoryRelayPresenceStore();
    return { clock, logger, relayPresence, relayIds: new Set([RELAY]) };
}

describe('recordPresence', () => {
    it('stores a configured relay’s list at the current time', async () => {
        const deps = setup();
        const [engine] = presenceEngineIds(1) as [EngineId];
        expect(await recordPresence(deps, RELAY, [engine])).toEqual({ kind: 'recorded' });
        expect(deps.relayPresence.reports.get(RELAY)).toEqual({
            reportedAt: deps.clock.nowMs(),
            engineIds: new Set([engine]),
        });
    });

    it('refuses a relay that is not in RELAYS and stores nothing', async () => {
        const deps = setup();
        expect(await recordPresence(deps, 'relay-x.ptbk.test', presenceEngineIds(1))).toEqual({
            kind: 'unknown-relay',
        });
        expect(deps.relayPresence.reports.size).toBe(0);
        expect(deps.logger.entries).toContainEqual({
            level: 'warn',
            event: 'presence.unknown-relay',
            fields: { relayId: 'relay-x.ptbk.test' },
        });
    });
});

describe('readReachableRelays', () => {
    it('is null until a relay reports, then counts every asked engine, 0 when none reported it', async () => {
        const deps = setup();
        const [reported, unreported] = presenceEngineIds(2) as [EngineId, EngineId];
        expect(await readReachableRelays(deps, [reported, unreported])).toBeNull();
        await recordPresence(deps, RELAY, [reported]);
        expect(await readReachableRelays(deps, [reported, unreported])).toEqual(
            new Map([
                [reported, 1],
                [unreported, 0],
            ]),
        );
    });

    it('expires a relay’s report 3 minutes after it was sent', async () => {
        const deps = setup();
        const [engine] = presenceEngineIds(1) as [EngineId];
        await recordPresence(deps, RELAY, [engine]);
        deps.clock.advance(PRESENCE_EXPIRY_MS - 1);
        expect(await readReachableRelays(deps, [engine])).toEqual(new Map([[engine, 1]]));
        deps.clock.advance(1);
        expect(await readReachableRelays(deps, [engine])).toBeNull();
    });

    it('answers null and logs when presence cannot be read', async () => {
        const deps = setup();
        const failing = { ...deps, relayPresence: { reachableRelays: () => Promise.reject(new Error('d1 down')) } };
        expect(await readReachableRelays(failing, presenceEngineIds(1))).toBeNull();
        expect(deps.logger.entries).toContainEqual({ level: 'error', event: 'presence.read-failed', fields: {} });
    });
});
