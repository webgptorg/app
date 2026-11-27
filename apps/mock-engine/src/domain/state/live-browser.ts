import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { BrowserTab, CapabilityRef } from '@ptbk/engine-api';
import type { InMemoryEngineController } from '@ptbk/engine-api/in-memory';

import type { Clock } from '../clock';

/**
 * The fake live browser behind `MOCK_LIVE_BROWSER=enabled` (`browser-tab@1`): one agent tab from startup, a sign-in
 * allowlist, and a tick that paces frames and ends sessions on time. Reserved `.example` origins only, so nothing the
 * mock shows can be mistaken for a real site.
 */
export const LIVE_BROWSER_TICK_MS = 500;
export const FAKE_AGENT_TAB_ORIGIN = 'https://shop.example';
export const LIVE_BROWSER_SIGN_IN_ORIGINS: readonly string[] = ['https://accounts.example'];

export function withLiveBrowser(capabilities: readonly CapabilityRef[]): readonly CapabilityRef[] {
    return capabilities.includes(KNOWN_CAPABILITIES.browserTab)
        ? capabilities
        : [...capabilities, KNOWN_CAPABILITIES.browserTab];
}

/** On a fresh core: the allowlist, and the fake agent's tab in the first seeded chat, if there is one. */
export function setUpLiveBrowser(controller: InMemoryEngineController, seededChatId: string | undefined): BrowserTab {
    controller.setBrowserSignInOrigins(LIVE_BROWSER_SIGN_IN_ORIGINS);
    const [agent] = controller.findAgents();
    return controller.openAgentTab({
        agentId: seededChatId === undefined ? null : (agent?.id ?? null),
        chatId: seededChatId ?? null,
        origin: FAKE_AGENT_TAB_ORIGIN,
    });
}

/** Calls `tick` every {@link LIVE_BROWSER_TICK_MS} on the clock until the returned function stops it. */
export function startLiveBrowserTicks(clock: Clock, tick: () => void): () => void {
    let cancel: (() => void) | null = null;
    const schedule = (): void => {
        cancel = clock.setTimeout(() => {
            try {
                tick();
            } finally {
                if (cancel !== null) schedule();
            }
        }, LIVE_BROWSER_TICK_MS);
    };
    schedule();
    return () => {
        const current = cancel;
        cancel = null;
        current?.();
    };
}
