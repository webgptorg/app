import { EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { RelayPresenceStore } from '../domain/presence/relay-presence-store';
import { MAX_PRESENCE_ENGINE_IDS } from '../shared/api/relay-presence';

const T = 1_800_000_000_000;
const RELAY_A = 'relay-a.ptbk.test';
const RELAY_B = 'relay-b.ptbk.test';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Well-formed engine IDs without a key behind them: the store never derives or verifies one. */
export function presenceEngineIds(count: number): EngineId[] {
    return Array.from({ length: count }, () =>
        EngineId.parse(Array.from(crypto.getRandomValues(new Uint8Array(26)), (byte) => BASE32[byte % 32]).join('')),
    );
}

/** One suite, run against D1 and the in-memory store. */
export function describeRelayPresenceStoreContract(name: string, makeStore: () => RelayPresenceStore): void {
    describe(`RelayPresenceStore contract: ${name}`, () => {
        let store: RelayPresenceStore;

        beforeEach(() => {
            store = makeStore();
        });

        it('knows nothing before any relay reported', async () => {
            const [engine] = presenceEngineIds(1);
            expect(await store.reachableRelays([engine as EngineId], T - 1)).toBeNull();
        });

        it('counts each engine once per relay that reported it, and leaves out the rest', async () => {
            const [both, onlyA, none] = presenceEngineIds(3) as [EngineId, EngineId, EngineId];
            await store.replace(RELAY_A, [both, onlyA], T, T - 180_000);
            await store.replace(RELAY_B, [both], T + 1, T + 1 - 180_000);
            const counts = await store.reachableRelays([both, onlyA, none], T - 1);
            expect(counts).toEqual(
                new Map([
                    [both, 2],
                    [onlyA, 1],
                ]),
            );
        });

        it('replaces a relay’s whole list with each report', async () => {
            const [kept, dropped, added] = presenceEngineIds(3) as [EngineId, EngineId, EngineId];
            await store.replace(RELAY_A, [kept, dropped], T, T - 180_000);
            await store.replace(RELAY_A, [kept, added], T + 60_000, T + 60_000 - 180_000);
            expect(await store.reachableRelays([kept, dropped, added], T + 59_999)).toEqual(
                new Map([
                    [kept, 1],
                    [added, 1],
                ]),
            );
            await store.replace(RELAY_A, [], T + 120_000, T + 120_000 - 180_000);
            expect(await store.reachableRelays([kept, dropped, added], T + 119_999)).toEqual(new Map());
        });

        it('counts only reports after `liveAfter`, and is empty-handed once none is', async () => {
            const [engine] = presenceEngineIds(1) as [EngineId];
            await store.replace(RELAY_A, [engine], T, T - 180_000);
            await store.replace(RELAY_B, [engine], T + 1000, T + 1000 - 180_000);
            expect(await store.reachableRelays([engine], T)).toEqual(new Map([[engine, 1]]));
            expect(await store.reachableRelays([engine], T + 1000)).toBeNull();
        });

        it('forgets relays whose last report expired when another relay reports', async () => {
            const [engine] = presenceEngineIds(1) as [EngineId];
            await store.replace(RELAY_A, [engine], T, T - 180_000);
            await store.replace(RELAY_B, [engine], T + 180_000, T);
            // Asked as if A were still live: its rows are gone, not merely ignored.
            expect(await store.reachableRelays([engine], T - 1)).toEqual(new Map([[engine, 1]]));
        });

        it('takes a report at the cap in one go', async () => {
            const many = presenceEngineIds(MAX_PRESENCE_ENGINE_IDS);
            await store.replace(RELAY_A, many, T, T - 180_000);
            const counts = await store.reachableRelays(many, T - 1);
            expect(counts?.size).toBe(MAX_PRESENCE_ENGINE_IDS);
            await store.replace(RELAY_A, many.slice(0, 1), T + 1, T + 1 - 180_000);
            expect((await store.reachableRelays(many, T))?.size).toBe(1);
        });
    });
}
