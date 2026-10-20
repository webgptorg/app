import { EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TestEngine } from '../testing/engines';
import { createTestEngine } from '../testing/engines';
import type { TestDeps } from '../testing/test-deps';
import { createTestDeps } from '../testing/test-deps';
import { MAX_NEGATIVE_ENTRIES, createCachedRegistry } from './cached-registry';
import type { EngineRegistry } from './engine-registry';

const SECOND = 1000;
const TTL_MS = 300 * SECOND;
const MAX_STALE_MS = 86_400 * SECOND;
const NEGATIVE_TTL_MS = 30 * SECOND;
const TIMEOUT_MS = 3 * SECOND;

const signal = new AbortController().signal;

describe('cached registry', () => {
    let engine: TestEngine;
    let unknown: TestEngine;
    let clock: TestDeps['clock'];
    let inner: TestDeps['registry'];
    let logger: TestDeps['logger'];
    let registry: EngineRegistry;

    beforeEach(async () => {
        engine = await createTestEngine(20);
        unknown = await createTestEngine(21);
        ({ clock, registry: inner, logger } = createTestDeps());
        inner.set(engine.engineId, engine.entry);
        registry = createCachedRegistry({
            inner,
            clock,
            logger,
            ttlMs: TTL_MS,
            maxStaleMs: MAX_STALE_MS,
            negativeTtlMs: NEGATIVE_TTL_MS,
            lookupTimeoutMs: TIMEOUT_MS,
        });
    });

    const found = () => ({ kind: 'found', entry: engine.entry });
    const events = () => logger.entries.map((entry) => entry.event);

    it('serves a hit within the TTL without asking the inner registry', async () => {
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual(found());
        clock.advance(TTL_MS - 1);
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual(found());
        expect(inner.calls()).toBe(1);
    });

    it('refetches once the TTL has passed and serves the new entry', async () => {
        await registry.lookup(engine.engineId, signal);
        const suspended = { ...engine.entry, status: 'suspended' as const };
        inner.set(engine.engineId, suspended);
        clock.advance(TTL_MS);
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'found', entry: suspended });
        expect(inner.calls()).toBe(2);
    });

    it.each([
        ['answers unavailable', 'unavailable'],
        ['throws', 'threw'],
    ] as const)('serves the stale entry when the inner registry %s', async (_, reason) => {
        await registry.lookup(engine.engineId, signal);
        clock.advance(TTL_MS);
        inner.setMode(reason === 'threw' ? 'throw' : 'unavailable');
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual(found());
        expect(logger.entries).toEqual([
            {
                level: 'warn',
                event: 'registry.stale',
                fields: { engineId: engine.engineId, reason, ageS: TTL_MS / SECOND },
            },
        ]);
    });

    it('serves the stale entry when the inner registry times out, and aborts the inner call', async () => {
        await registry.lookup(engine.engineId, signal);
        clock.advance(TTL_MS);
        inner.setMode('hang');
        const lookup = registry.lookup(engine.engineId, signal);
        await Promise.resolve();
        clock.advance(TIMEOUT_MS);
        await expect(lookup).resolves.toEqual(found());
        expect(logger.entries[0]?.fields).toMatchObject({ reason: 'timeout' });
        expect(clock.pendingTimers()).toBe(0);
    });

    it.each(['unavailable', 'throw'] as const)(
        'answers unavailable when the inner registry fails (%s) and nothing is cached',
        async (mode) => {
            inner.setMode(mode);
            await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'unavailable' });
            expect(events()).toEqual(['registry.unavailable']);
        },
    );

    it('serves a stale entry just under 24 hours old and refuses it at 24 hours', async () => {
        await registry.lookup(engine.engineId, signal);
        inner.setMode('unavailable');
        clock.advance(MAX_STALE_MS - 1);
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual(found());
        clock.advance(1);
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'unavailable' });
        expect(events()).toEqual(['registry.stale', 'registry.unavailable']);
    });

    it('keeps the age of the last successful fetch while serving stale entries', async () => {
        await registry.lookup(engine.engineId, signal);
        inner.setMode('unavailable');
        for (let hour = 1; hour < 24; hour++) {
            clock.advance(3600 * SECOND);
            await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual(found());
        }
        clock.advance(3600 * SECOND);
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'unavailable' });
    });

    it('caches not-found for 30 seconds only', async () => {
        await expect(registry.lookup(unknown.engineId, signal)).resolves.toEqual({ kind: 'not-found' });
        clock.advance(NEGATIVE_TTL_MS - 1);
        await expect(registry.lookup(unknown.engineId, signal)).resolves.toEqual({ kind: 'not-found' });
        expect(inner.calls()).toBe(1);
        inner.set(unknown.engineId, unknown.entry);
        clock.advance(1);
        await expect(registry.lookup(unknown.engineId, signal)).resolves.toEqual({
            kind: 'found',
            entry: unknown.entry,
        });
        expect(inner.calls()).toBe(2);
    });

    it('drops a cached entry when the engine is no longer registered, so it is never served stale', async () => {
        await registry.lookup(engine.engineId, signal);
        inner.delete(engine.engineId);
        clock.advance(TTL_MS);
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'not-found' });
        inner.setMode('unavailable');
        clock.advance(NEGATIVE_TTL_MS);
        await expect(registry.lookup(engine.engineId, signal)).resolves.toEqual({ kind: 'unavailable' });
    });

    it('does not serve a stale not-found while the inner registry fails', async () => {
        await registry.lookup(unknown.engineId, signal);
        inner.setMode('unavailable');
        clock.advance(NEGATIVE_TTL_MS);
        await expect(registry.lookup(unknown.engineId, signal)).resolves.toEqual({ kind: 'unavailable' });
    });

    it('makes one inner call for ten concurrent lookups', async () => {
        const lookups = Array.from({ length: 10 }, () => registry.lookup(engine.engineId, signal));
        await expect(Promise.all(lookups)).resolves.toEqual(Array.from({ length: 10 }, found));
        expect(inner.calls()).toBe(1);
    });

    it('stops waiting when the signal aborts, while the shared fetch still fills the cache', async () => {
        inner.setMode('hang');
        const controller = new AbortController();
        const reason = new Error('tunnel closed');
        const abandoned = registry.lookup(engine.engineId, controller.signal);
        const patient = registry.lookup(engine.engineId, signal);
        controller.abort(reason);
        await expect(abandoned).rejects.toBe(reason);
        await Promise.resolve();
        clock.advance(TIMEOUT_MS);
        await expect(patient).resolves.toEqual({ kind: 'unavailable' });
        expect(inner.calls()).toBe(1);
    });

    it('rejects at once for an already-aborted signal, without asking the inner registry', async () => {
        const reason = new Error('gone');
        await expect(registry.lookup(engine.engineId, AbortSignal.abort(reason))).rejects.toBe(reason);
        expect(inner.calls()).toBe(0);
    });

    it('bounds the negative cache by evicting the oldest entry', async () => {
        const first = await createTestEngine(22);
        await registry.lookup(first.engineId, signal);
        const ids = Array.from({ length: MAX_NEGATIVE_ENTRIES }, (_, index) => syntheticId(index));
        for (const id of ids) await registry.lookup(id, signal);
        const callsBefore = inner.calls();
        await registry.lookup(syntheticId(MAX_NEGATIVE_ENTRIES - 1), signal);
        expect(inner.calls()).toBe(callsBefore);
        await registry.lookup(first.engineId, signal);
        expect(inner.calls()).toBe(callsBefore + 1);
    });
});

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A well-formed engine ID without a key behind it: the registry only ever compares IDs. */
function syntheticId(index: number): EngineId {
    let id = '';
    for (let rest = index; id.length < 26; rest = Math.floor(rest / 32)) id = BASE32.charAt(rest % 32) + id;
    return EngineId.parse(id);
}
