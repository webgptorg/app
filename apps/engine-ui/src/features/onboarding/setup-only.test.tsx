import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { EngineApiClient, ReadOnboardingState } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;

const PENDING: ReadOnboardingState = {
    status: 'pending',
    deferred: false,
    canDefer: false,
    progress: null,
    activity: [],
    prompt: {
        id: 'p1',
        kind: 'confirm',
        title: 'Your project',
        question: 'Start?',
        hint: null,
        error: null,
        canGoBack: false,
        details: [],
        alternatives: [],
        confirmLabel: 'Start',
        declineLabel: 'Not yet',
    },
};

const DONE: ReadOnboardingState = {
    status: 'completed',
    deferred: false,
    canDefer: true,
    progress: null,
    activity: [],
    prompt: null,
};

/** A paired engine with no project: it advertises only setup and files, and its setup moves to `next` on an answer. */
function pairedEngine(first: ReadOnboardingState, next: ReadOnboardingState = DONE): EngineApiClient {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: { engine: { name: 'New engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' } },
        capabilities: [KNOWN_CAPABILITIES.files, KNOWN_CAPABILITIES.onboarding],
    });
    let state = first;
    return {
        ...engine.client,
        onboarding: {
            get: () => Promise.resolve({ kind: 'ok', data: state }),
            answer: () => {
                state = next;
                return Promise.resolve({ kind: 'ok', data: state });
            },
            defer: () => Promise.resolve({ kind: 'ok', data: state }),
        },
    };
}

describe('an engine that is only being set up', { timeout: TIMEOUT_MS }, () => {
    it('opens on setup from any page, with no navigation into pages that would be empty', async () => {
        const { router } = renderWithProviders({ path: '/files', engineApi: pairedEngine(PENDING) });
        expect(await screen.findByRole('heading', { level: 1, name: 'Your project' })).toBeDefined();
        expect(router.state.location.pathname).toBe('/onboarding');
        expect(screen.queryByRole('navigation')).toBeNull();
        expect(screen.queryByRole('button', { name: /Search/ })).toBeNull();
        expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();

        await router.navigate({ to: '/' });
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/onboarding');
        });
    });

    it('gets the whole app once setup is done', async () => {
        const { router, user } = renderWithProviders({ engineApi: pairedEngine(PENDING) });
        await user.click(await screen.findByRole('button', { name: 'Start' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Your engine is set up' })).toBeDefined();
        expect(await screen.findByRole('navigation')).toBeDefined();
        await router.navigate({ to: '/files' });
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/files');
        });
    });

    it('is how the reference engine presents an engine paired before it has a project', async () => {
        const engine = createInMemoryEngine({
            clock: { now: () => TEST_NOW },
            seed: {
                engine: { name: 'New engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
                onboarding: 'no-project',
            },
            capabilities: [KNOWN_CAPABILITIES.files, KNOWN_CAPABILITIES.onboarding],
        });
        const { router } = renderWithProviders({ engineApi: engine.client });
        expect(await screen.findByText(/Your answers are saved/)).toBeDefined();
        expect(router.state.location.pathname).toBe('/onboarding');
        expect(screen.queryByRole('navigation')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    });

    it('keeps the whole app around a setup the owner may skip', async () => {
        renderWithProviders({ path: '/onboarding', engineApi: pairedEngine({ ...PENDING, canDefer: true }) });
        expect(await screen.findByRole('button', { name: 'Skip for now' })).toBeDefined();
        expect(screen.getByRole('navigation')).toBeDefined();
    });
});
