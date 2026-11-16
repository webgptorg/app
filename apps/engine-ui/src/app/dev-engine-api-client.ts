import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { EngineApiClient } from '@ptbk/engine-api';
import { createDemoSeed, createInMemoryEngineApiClient, demoReplyScript } from '@ptbk/engine-api/in-memory';

import { demoAdminExtras } from './dev-demo-extras';

/**
 * Offline development (`VITE_ENGINE_API=memory`): the demo engine's agents, runs, files, triggers and integrations with
 * the contract's rules, no mock engine needed. Agents reply with live steps before their text, as Reborn's do. Like the
 * mock engine, it shows only what the Reborn engine has unless `VITE_ENGINE_PROFILE=full`.
 */
export function createDevEngineApiClient(): EngineApiClient {
    const now = new Date();
    const seed = createDemoSeed(now);
    // The browser is the client here, so this session reads as the device it really is.
    const userAgent = navigator.userAgent.slice(0, 512);
    return createInMemoryEngineApiClient({
        replyScript: demoReplyScript,
        client: { ip: '127.0.0.1', userAgent },
        seed: {
            ...seed,
            ...demoAdminExtras(now, userAgent),
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
            : { capabilities: [KNOWN_CAPABILITIES.tasks, KNOWN_CAPABILITIES.files, KNOWN_CAPABILITIES.onboarding] }),
    });
}
