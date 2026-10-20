import type { EngineId, RegistryEntry } from '@ptbk/protocol';

import { abortable } from './abortable';
import { callWithTimeout } from './call-with-timeout';
import type { Clock } from './clock';
import type { EngineRegistry, RegistryLookup } from './engine-registry';
import type { Logger } from './logger';
import { createSingleFlight } from './single-flight';

/**
 * Engine IDs reach the registry from unauthenticated tunnel handshakes, so negative entries are capped (oldest evicted
 * first). Positive entries are bounded by the registry itself.
 */
export const MAX_NEGATIVE_ENTRIES = 10_000;

export interface CachedRegistryOptions {
    readonly inner: EngineRegistry;
    readonly clock: Clock;
    readonly logger: Logger;
    /** How long a `found` entry is served without asking `inner` (`RELAY_REGISTRY_TTL_S`). */
    readonly ttlMs: number;
    /** How old a `found` entry may be and still answer while `inner` fails (`RELAY_REGISTRY_MAX_STALE_S`). */
    readonly maxStaleMs: number;
    /** How long `not-found` is served without asking `inner`; short, so a newly registered engine is not blocked. */
    readonly negativeTtlMs: number;
    /** `RELAY_REGISTRY_TIMEOUT_MS`; a slower answer counts as a failure. */
    readonly lookupTimeoutMs: number;
}

interface Positive {
    readonly entry: RegistryEntry;
    readonly fetchedAtMs: number;
}

/**
 * Freshness, stale-on-error and request sharing for every registry adapter. A stale entry answers only while it is
 * younger than `maxStaleMs`, so a suspension takes effect within that window even while the dashboard is down.
 */
export function createCachedRegistry(options: CachedRegistryOptions): EngineRegistry {
    const { inner, clock, logger, ttlMs, maxStaleMs, negativeTtlMs, lookupTimeoutMs } = options;
    const positives = new Map<EngineId, Positive>();
    const negatives = new Map<EngineId, number>();
    const flights = createSingleFlight<EngineId, RegistryLookup>();

    function cached(engineId: EngineId, nowMs: number): RegistryLookup | undefined {
        const positive = positives.get(engineId);
        if (positive !== undefined && nowMs - positive.fetchedAtMs < ttlMs) {
            return { kind: 'found', entry: positive.entry };
        }
        const negativeAtMs = negatives.get(engineId);
        if (negativeAtMs !== undefined && nowMs - negativeAtMs < negativeTtlMs) return { kind: 'not-found' };
        return undefined;
    }

    function rememberNotFound(engineId: EngineId, nowMs: number): void {
        positives.delete(engineId);
        negatives.delete(engineId);
        negatives.set(engineId, nowMs);
        // Maps iterate in insertion order, and a refreshed ID was re-inserted above, so the first key is the oldest.
        if (negatives.size > MAX_NEGATIVE_ENTRIES) negatives.delete(negatives.keys().next().value as EngineId);
    }

    async function refresh(engineId: EngineId): Promise<RegistryLookup> {
        const outcome = await callWithTimeout(clock, lookupTimeoutMs, (signal) => inner.lookup(engineId, signal));
        const nowMs = clock.nowMs();
        if (outcome.kind === 'done') {
            const lookup = outcome.value;
            switch (lookup.kind) {
                case 'found':
                    negatives.delete(engineId);
                    positives.set(engineId, { entry: lookup.entry, fetchedAtMs: nowMs });
                    return lookup;
                case 'not-found':
                    rememberNotFound(engineId, nowMs);
                    return lookup;
                case 'unavailable':
                    break;
            }
        }
        const reason = outcome.kind === 'done' ? 'unavailable' : outcome.kind;
        const stale = positives.get(engineId);
        if (stale !== undefined && nowMs - stale.fetchedAtMs < maxStaleMs) {
            logger.warn('registry.stale', { engineId, reason, ageS: Math.floor((nowMs - stale.fetchedAtMs) / 1000) });
            return { kind: 'found', entry: stale.entry };
        }
        logger.warn('registry.unavailable', { engineId, reason });
        return { kind: 'unavailable' };
    }

    return {
        lookup(engineId, signal) {
            if (signal.aborted) return Promise.reject(signal.reason as Error);
            const hit = cached(engineId, clock.nowMs());
            if (hit !== undefined) return Promise.resolve(hit);
            return abortable(
                flights.run(engineId, () => refresh(engineId)),
                signal,
            );
        },
    };
}
