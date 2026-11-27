import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { createDemoSeed } from '@ptbk/engine-api/in-memory';
import type { InMemorySeed } from '@ptbk/engine-api/in-memory';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createTestEngineApi, FORMER_CORE_CAPABILITIES, TEST_NOW } from '../../testing/test-engine-api';
import { HOME_GUIDE_DISMISSED_KEY } from './home-guide';

const TIMEOUT_MS = 20_000;
const CAPABILITIES = [...FORMER_CORE_CAPABILITIES, KNOWN_CAPABILITIES.wallet];
const ENGINE = { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' } as const;
const CHATTER = { id: 'builtin-chatter', source: 'Chatter\nPERSONA Talks with you first.', origin: 'core' } as const;

function engine(seed: InMemorySeed) {
    return createTestEngineApi({ seed: { engine: ENGINE, ...seed }, capabilities: CAPABILITIES });
}

const guide = () => document.querySelector<HTMLElement>('[data-home-guide]');

describe('Home guide', { timeout: TIMEOUT_MS }, () => {
    it('offers a new engine its first step, one line and one action', async () => {
        const { container } = renderWithProviders({
            engineApi: engine({ agents: [CHATTER], wallet: { state: 'empty' } }),
        });
        expect(await screen.findByText(/Start with one agent/)).toBeDefined();
        expect(screen.getByRole('link', { name: 'Create an agent' }).getAttribute('href')).toBe('/agents/new');
        expect(guide()?.dataset['homeGuide']).toBe('create-agent');
        expect(screen.queryByRole('link', { name: 'Set up your Wallet' })).toBeNull();
        await expectNoAxeViolations(container);
    });

    it('moves on to the Wallet once an agent exists', async () => {
        renderWithProviders({
            engineApi: engine({ agents: [CHATTER, { source: 'Ada\nPERSONA Research' }], wallet: { state: 'empty' } }),
        });
        expect(await screen.findByRole('link', { name: 'Set up your Wallet' })).toBeDefined();
        expect(guide()?.dataset['homeGuide']).toBe('set-up-wallet');
    });

    it('asks to invite a colleague while the owner is alone', async () => {
        const demo = createDemoSeed(TEST_NOW);
        renderWithProviders({ engineApi: engine({ ...demo, engine: ENGINE, members: [], invites: [], chats: [] }) });
        expect(await screen.findByRole('link', { name: 'Invite a colleague' })).toBeDefined();
    });

    it('points to the composer when there are no chats yet', async () => {
        const demo = createDemoSeed(TEST_NOW);
        const { user } = renderWithProviders({
            engineApi: createTestEngineApi({ seed: { ...demo, engine: ENGINE, chats: [] } }),
        });
        await user.click(await screen.findByRole('button', { name: 'Ask Chatter…' }));
        expect(document.activeElement?.tagName).toBe('TEXTAREA');
    });

    it('becomes a tip once all is set, and stays dismissed on this device', async () => {
        const demo = createDemoSeed(TEST_NOW);
        const first = renderWithProviders({ engineApi: engine({ ...demo, engine: ENGINE }) });
        await waitFor(() => {
            expect(guide()?.dataset['homeGuide']).toBe('done');
        });
        await first.user.click(screen.getByRole('button', { name: 'Hide this tip' }));
        expect(guide()).toBeNull();
        expect(first.storage.getItem(HOME_GUIDE_DISMISSED_KEY)).toBe('1');
        cleanup();

        renderWithProviders({ engineApi: engine({ ...demo, engine: ENGINE }), storage: first.storage });
        expect(await screen.findByRole('heading', { level: 1, name: /Good/ })).toBeDefined();
        await screen.findByRole('region', { name: /^Recent chats/ });
        expect(guide()).toBeNull();
    });
});
