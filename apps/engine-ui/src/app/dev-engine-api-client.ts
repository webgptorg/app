import { createDemoSeed, createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { EngineApiClient } from '@ptbk/engine-api';

/**
 * Offline development (`VITE_ENGINE_API=memory`): the demo engine's agents, runs, files, triggers and integrations with
 * the contract's rules, no mock engine needed.
 */
export function createDevEngineApiClient(): EngineApiClient {
    const seed = createDemoSeed();
    return createInMemoryEngineApiClient({
        seed: {
            ...seed,
            engine: {
                ...seed.engine,
                name: 'Dev engine',
                hostname: 'engine.localhost',
                dashboardUrl: null,
                mode: 'local',
            },
        },
    });
}
