import type { EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PublicFaceStore } from '../domain/abuse/public-face-store';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ALL = 10_000;

export interface PublicFaceStoreFixture {
    readonly store: PublicFaceStore;
    /** Registers an engine, active unless said otherwise; its ID and default hostname. */
    addEngine(status?: 'active' | 'suspended'): Promise<{ readonly engineId: EngineId; readonly hostname: string }>;
    /** Every stored check of the engine, oldest first. */
    checksOf(engineId: EngineId): Promise<readonly { readonly checkedAt: number; readonly result: string }[]>;
}

/** One suite, run against the D1 and the in-memory store; other tests' engines may be there too (one D1 per file). */
export function describePublicFaceStoreContract(name: string, makeFixture: () => PublicFaceStoreFixture): void {
    describe(`PublicFaceStore contract: ${name}`, () => {
        let fixture: PublicFaceStoreFixture;

        beforeEach(() => {
            fixture = makeFixture();
        });

        async function dueOrder(ids: readonly EngineId[]): Promise<readonly EngineId[]> {
            const due = await fixture.store.due(ALL);
            return due.map((engine) => engine.engineId).filter((id) => ids.includes(id));
        }

        it('offers active engines never checked first, then the longest unchecked', async () => {
            const { store } = fixture;
            const a = await fixture.addEngine();
            const b = await fixture.addEngine();
            const c = await fixture.addEngine();
            const suspended = await fixture.addEngine('suspended');
            await store.record([
                { engineId: a.engineId, checkedAt: NOW - HOUR, result: 'match', fingerprint: 'f'.repeat(64) },
                { engineId: b.engineId, checkedAt: NOW - 2 * HOUR, result: 'unreachable', fingerprint: null },
            ]);
            expect(await dueOrder([a.engineId, b.engineId, c.engineId, suspended.engineId])).toEqual([
                c.engineId,
                b.engineId,
                a.engineId,
            ]);
            const due = await store.due(ALL);
            expect(due.find((engine) => engine.engineId === c.engineId)).toEqual(c);
        });

        it('limits how many it offers', async () => {
            await fixture.addEngine();
            await fixture.addEngine();
            expect(await fixture.store.due(1)).toHaveLength(1);
        });

        it('records a check once per engine and time, and prunes old ones', async () => {
            const { store } = fixture;
            const engine = await fixture.addEngine();
            const check = {
                engineId: engine.engineId,
                checkedAt: NOW,
                result: 'mismatch',
                fingerprint: 'a'.repeat(64),
            } as const;
            const old = { ...check, checkedAt: NOW - 40 * 24 * HOUR, result: 'match' } as const;
            await store.record([old, check]);
            await store.record([{ ...check, result: 'match' }]);
            expect(await fixture.checksOf(engine.engineId)).toEqual([
                { checkedAt: old.checkedAt, result: 'match' },
                { checkedAt: NOW, result: 'mismatch' },
            ]);
            await store.prune(NOW - 30 * 24 * HOUR);
            expect(await fixture.checksOf(engine.engineId)).toEqual([{ checkedAt: NOW, result: 'mismatch' }]);
        });

        it('records more checks than one statement binds', async () => {
            const engine = await fixture.addEngine();
            await fixture.store.record(
                Array.from({ length: 60 }, (_, index) => ({
                    engineId: engine.engineId,
                    checkedAt: NOW + index,
                    result: 'unreachable' as const,
                    fingerprint: null,
                })),
            );
            expect(await fixture.checksOf(engine.engineId)).toHaveLength(60);
        });

        it('counts active engines without a check since a time', async () => {
            const { store } = fixture;
            const since = NOW + 1_000 * HOUR;
            const before = await store.countUncheckedSince(since);
            const fresh = await fixture.addEngine();
            const stale = await fixture.addEngine();
            await fixture.addEngine('suspended');
            await store.record([
                { engineId: fresh.engineId, checkedAt: since, result: 'match', fingerprint: 'b'.repeat(64) },
                { engineId: stale.engineId, checkedAt: since - 1, result: 'match', fingerprint: 'b'.repeat(64) },
            ]);
            expect(await store.countUncheckedSince(since)).toBe(before + 1);
        });
    });
}
