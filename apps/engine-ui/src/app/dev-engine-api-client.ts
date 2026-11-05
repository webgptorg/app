import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { EngineApiClient } from '@ptbk/engine-api';
import { createDemoSeed, createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';

/**
 * Offline development (`VITE_ENGINE_API=memory`): the demo engine's agents, runs, files, triggers and integrations with
 * the contract's rules, no mock engine needed. Like the mock engine, it shows only what the Reborn engine has unless
 * `VITE_ENGINE_PROFILE=full`.
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
            ...(import.meta.env.VITE_ENGINE_ONBOARDING === 'pending' ? { onboarding: 'pending' as const } : {}),
        },
        ...(import.meta.env.VITE_ENGINE_PROFILE === 'full'
            ? {}
            : { capabilities: [KNOWN_CAPABILITIES.files, KNOWN_CAPABILITIES.onboarding] }),
    });
}
