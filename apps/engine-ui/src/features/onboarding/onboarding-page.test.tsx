import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineApiOptions } from '@ptbk/engine-api/in-memory';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;

function pendingEngine(options: InMemoryEngineApiOptions = {}) {
    return createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            onboarding: 'pending',
            agents: [{ id: 'builtin-chatter', source: 'Chatter\nPERSONA Talks with you first.', origin: 'core' }],
        },
        capabilities: [KNOWN_CAPABILITIES.files, KNOWN_CAPABILITIES.onboarding],
        ...options,
    });
}

const continueButton = () => screen.getByRole('button', { name: 'Continue' });
/** The robot guiding setup is decoration; its pose is the one thing about it worth checking. */
const robotPose = () => document.querySelector('svg[data-pose]')?.getAttribute('data-pose');

describe('onboarding', { timeout: TIMEOUT_MS }, () => {
    it('opens a new engine on its setup, and renders whatever the engine asks, with its progress', async () => {
        const engine = pendingEngine();
        const { router, user, container } = renderWithProviders({ engineApi: engine.client });
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/onboarding');
        });
        expect(await screen.findByRole('heading', { level: 1, name: 'Your project' })).toBeDefined();
        expect(screen.getByText('Step 1 of 4')).toBeDefined();
        expect(screen.getByText(/Tell me a little about your project/)).toBeDefined();
        expect(robotPose()).toBe('thinking');
        await expectNoAxeViolations(container);

        await user.type(screen.getByRole('textbox', { name: 'What are you working on?' }), 'Books for my bakery');
        await user.click(continueButton());
        expect(await screen.findByRole('heading', { level: 1, name: 'AI tool' })).toBeDefined();
        expect(screen.getByRole<HTMLInputElement>('radio', { name: /OpenAI Codex/ }).checked).toBe(true);
        await user.click(screen.getByRole('radio', { name: /Claude Code/ }));
        await user.click(continueButton());

        expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Claude Code' })).toBeDefined();
        expect(screen.getByText(/Sign in to your AI tool/)).toBeDefined();
        const link = screen.getByRole('link', { name: /Open the Claude Code sign-in page/ });
        expect(link.getAttribute('href')).toBe('https://claude.ai/oauth/authorize');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        await user.type(screen.getByRole('textbox', { name: 'Code from Claude Code' }), 'abc');
        await user.click(continueButton());
        expect(await screen.findByText(/does not look complete/)).toBeDefined();
        await user.clear(screen.getByRole('textbox', { name: 'Code from Claude Code' }));
        await user.type(screen.getByRole('textbox', { name: 'Code from Claude Code' }), 'a1B2c3D4e5');
        await user.click(continueButton());

        expect(await screen.findByRole('heading', { level: 1, name: 'Files' })).toBeDefined();
        expect(screen.getByText('Step 4 of 4')).toBeDefined();
        expect(robotPose()).toBe('assembling');
        await user.click(continueButton());
        expect(await screen.findByRole('heading', { level: 1, name: 'Your engine is set up' })).toBeDefined();
        expect(screen.getByText('Done. Your agents can get to work.')).toBeDefined();
        expect(robotPose()).toBe('finished');
        expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    });

    it('shows a device code to type at the provider, and a failed sign-in with its reason and a way to start again', async () => {
        const engine = pendingEngine();
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Continue' }));
        await user.click(await screen.findByRole('button', { name: 'Continue' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to OpenAI Codex' })).toBeDefined();
        expect(screen.getByText('K7QF-3MRP')).toBeDefined();
        expect(screen.getByText('Waiting for you to finish signing in…')).toBeDefined();

        // The page polls while a sign-in waits, so the engine's verdict arrives without a click.
        engine.controller.settleHarnessLogin('denied', 'Device-code sign-in is off for this workspace.');
        expect(
            await screen.findByText('Device-code sign-in is off for this workspace.', {}, { timeout: 5_000 }),
        ).toBeDefined();
        await user.click(screen.getByRole('button', { name: 'Start again' }));
        expect(await screen.findByText('H2WD-8XNL')).toBeDefined();
    });

    it('goes back with the draft kept', async () => {
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: pendingEngine().client });
        await user.type(await screen.findByRole('textbox', { name: 'What are you working on?' }), 'My agenda');
        await user.click(continueButton());
        await user.click(await screen.findByRole('button', { name: 'Back' }));
        expect(
            (await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'What are you working on?' })).value,
        ).toBe('My agenda');
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('skips for now to a chat with Chatter, and Home offers the setup again', async () => {
        const engine = pendingEngine();
        const { router, user } = renderWithProviders({ path: '/onboarding', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/agents/builtin-chatter/chat');
        });
        await router.navigate({ to: '/' });
        const notice = await screen.findByText('Your engine is not set up yet');
        const banner = notice.closest('[role]') ?? document.body;
        expect(
            within(banner as HTMLElement)
                .getByRole('link', { name: 'Continue setup' })
                .getAttribute('href'),
        ).toBe('/onboarding');
        expect(router.state.location.pathname).toBe('/');
    });

    it('leaves Home alone on a set-up engine', async () => {
        const engine = pendingEngine({
            seed: {
                engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
                onboarding: 'completed',
            },
        });
        const { router } = renderWithProviders({ engineApi: engine.client });
        expect(await screen.findByRole('heading', { level: 1, name: /Good/ })).toBeDefined();
        expect(router.state.location.pathname).toBe('/');
        expect(screen.queryByText('Your engine is not set up yet')).toBeNull();
    });
});
