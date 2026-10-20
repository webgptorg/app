import { createInMemoryEngineApiClient } from '@ptbk/engine-api';
import type { EngineApiClient } from '@ptbk/engine-api';

/** Offline development (`VITE_ENGINE_API=memory`): fake data with the contract's rules, no mock engine needed. */
export function createDevEngineApiClient(): EngineApiClient {
    return createInMemoryEngineApiClient({
        seed: {
            engine: { name: 'Dev engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            agents: [
                { source: 'Ada\nPERSONA A careful research assistant' },
                { source: 'Grace\nPERSONA Reviews pull requests' },
                { source: 'Linus\nPERSONA Keeps the build green' },
            ],
        },
    });
}
