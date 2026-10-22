import type { WsTunnelOptions } from '../adapters/ws-tunnel-transport';
import type { CachedRegistry } from '../domain/cached-registry';
import type { Clock } from '../domain/clock';
import type { EngineRegistry } from '../domain/engine-registry';
import { createMemoryBudget } from '../domain/limits/memory-budget';
import type { TunnelSessionLimits } from '../domain/tunnel/tunnel-session';
import { createMemoryLogger } from '../adapters/memory-logger';
import { createFakeRandom } from './fake-random';

/** Generous enough that no test trips the frame budget by accident. */
export const TEST_SESSION_LIMITS: TunnelSessionLimits = { framesPerS: 1_000_000, minWindowIncrementBytes: 1024 };

/** `attachWsTunnel` options with the production limits, a fresh budget and throwaway logger and counters. */
export function testWsTunnelOptions(clock: Clock, overrides: Partial<WsTunnelOptions> = {}): WsTunnelOptions {
    return {
        clock,
        random: createFakeRandom(),
        logger: createMemoryLogger(),
        limits: { pingBufferBytes: 1_048_576, maxBufferedBytes: 8_388_608 },
        memory: createMemoryBudget(1_073_741_824),
        terminations: { count: () => undefined },
        ...overrides,
    };
}

/** A registry for the tunnel endpoint that never claims a cache hit, so every lookup reaches `registry`. */
export function uncached(registry: EngineRegistry): Pick<CachedRegistry, 'lookup' | 'has'> {
    return { lookup: (engineId, signal) => registry.lookup(engineId, signal), has: () => false };
}
