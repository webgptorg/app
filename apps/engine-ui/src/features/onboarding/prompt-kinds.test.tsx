import { KNOWN_CAPABILITIES, OWNER_PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import type { EngineApiClient, OnboardingAnswer, OnboardingPrompt, OnboardingState } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;

const base = { title: 'Setup', hint: null, error: null, canGoBack: false };

function pending(prompt: OnboardingPrompt): OnboardingState {
    return { status: 'pending', deferred: false, progress: { step: 1, of: 2 }, prompt };
}

const DONE: OnboardingState = { status: 'completed', deferred: false, progress: null, prompt: null };

/** The in-memory engine for everything else, with an onboarding that serves `states` in turn and records answers. */
function scripted(
    states: readonly OnboardingState[],
    options: { readonly withChatter?: boolean; readonly permissions?: readonly Permission[] } = {},
) {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            agents:
                options.withChatter === false
                    ? []
                    : [{ id: 'builtin-chatter', source: 'Chatter\nPERSONA Talks with you first.', origin: 'core' }],
        },
        capabilities: [KNOWN_CAPABILITIES.files, KNOWN_CAPABILITIES.onboarding],
        ...(options.permissions === undefined
            ? {}
            : { member: { permissions: options.permissions, role: 'member' as const } }),
    });
    let index = 0;
    let deferred = false;
    const current = (): OnboardingState => ({
        ...(states[Math.min(index, states.length - 1)] as OnboardingState),
        ...(deferred ? { deferred } : {}),
    });
    const answers: OnboardingAnswer[] = [];
    const client: EngineApiClient = {
        ...engine.client,
        onboarding: {
            get: () => Promise.resolve({ kind: 'ok', data: current() }),
            answer: (body) => {
                if (body.action === 'answer') answers.push(body.answer as OnboardingAnswer);
                index++;
                return Promise.resolve({ kind: 'ok', data: current() });
            },
            defer: () => {
                deferred = true;
                return Promise.resolve({ kind: 'ok', data: current() });
            },
        },
    };
    return { client, answers };
}

describe('onboarding prompt kinds', { timeout: TIMEOUT_MS }, () => {
    it('answers a confirm prompt with the button the member picks', async () => {
        const { client, answers } = scripted([
            pending({ ...base, id: 'p1', kind: 'confirm', question: 'Sync?', confirmLabel: 'Yes', declineLabel: 'No' }),
            DONE,
        ]);
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: client });
        await user.click(await screen.findByRole('button', { name: 'No' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Your engine is set up' })).toBeDefined();
        expect(answers).toEqual([{ kind: 'confirm', confirmed: false }]);
    });

    it('takes several choices, skips disabled ones, and a single-line text that is required', async () => {
        const { client, answers } = scripted([
            pending({
                ...base,
                id: 'p1',
                kind: 'choice',
                question: 'Which tools?',
                hint: 'Pick any.',
                multiple: true,
                choices: [
                    { id: 'a', label: 'Alpha', description: null, disabled: false },
                    { id: 'b', label: 'Beta', description: 'Second', disabled: false },
                    { id: 'c', label: 'Gamma', description: null, disabled: true },
                ],
                initial: ['a'],
            }),
            pending({
                ...base,
                id: 'p2',
                kind: 'text',
                question: 'Project name',
                multiline: false,
                required: true,
                placeholder: null,
                initial: '',
                attachments: false,
                error: 'Names must be short.',
            }),
            DONE,
        ]);
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: client });
        await user.click(await screen.findByRole('checkbox', { name: /Beta/ }));
        await user.click(screen.getByRole('checkbox', { name: /Alpha/ }));
        expect(screen.getByRole('checkbox', { name: /Gamma/ }).hasAttribute('disabled')).toBe(true);
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        const name = await screen.findByRole('textbox', { name: /Project name/ });
        expect(screen.getByText('Names must be short.')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
        await user.type(name, 'Bakery');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByRole('heading', { level: 1, name: 'Your engine is set up' });
        expect(answers).toEqual([
            { kind: 'choice', choiceIds: ['b'] },
            { kind: 'text', text: 'Bakery', fileIds: [] },
        ]);
    });

    it('asks as Chatter, keeps Enter for new lines in a long answer, and continues on Ctrl+Enter', async () => {
        const { client, answers } = scripted([
            pending({
                ...base,
                id: 'p1',
                kind: 'text',
                question: 'What are you working on?',
                multiline: true,
                required: true,
                placeholder: null,
                initial: '',
                attachments: false,
            }),
            DONE,
        ]);
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: client });
        const answer = await screen.findByRole('textbox', { name: 'What are you working on?' });
        expect(screen.getByText('Chatter')).toBeDefined();
        expect(screen.getByText('Step 1 of 2')).toBeDefined();
        await user.type(answer, 'Bread{Enter}Cakes');
        expect(answers).toEqual([]);
        await user.keyboard('{Control>}{Enter}{/Control}');
        await screen.findByRole('heading', { level: 1, name: 'Your engine is set up' });
        expect(answers).toEqual([{ kind: 'text', text: 'Bread\nCakes', fileIds: [] }]);
    });

    it('shows Chatter by its initial without agents.read, and never asks for the agent list', async () => {
        const { client } = scripted(
            [pending({ ...base, id: 'p1', kind: 'confirm', question: 'Go?', confirmLabel: 'Yes', declineLabel: 'No' })],
            { permissions: OWNER_PERMISSIONS.filter((permission) => permission !== 'agents.read') },
        );
        const list = vi.spyOn(client.agents, 'list');
        renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByRole('button', { name: 'Yes' })).toBeDefined();
        expect(screen.getByText('Chatter')).toBeDefined();
        expect(list).not.toHaveBeenCalled();
    });

    it('uploads files with the files capability, lets one go again, and names the file it could not add', async () => {
        const { client, answers } = scripted([
            pending({ ...base, id: 'p1', kind: 'upload', question: 'Any files?', required: true, maxFiles: 2 }),
            DONE,
        ]);
        const upload = vi.spyOn(client.files, 'upload');
        const { user, container } = renderWithProviders({ path: '/onboarding', engineApi: client });
        await screen.findByText('Any files?');
        expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
        const input = container.querySelector<HTMLInputElement>('input[type="file"]');
        if (input === null) throw new Error('no file input');
        const files = ['notes.txt', 'plan.txt', 'extra.txt'].map(
            (name) => new File(['x'], name, { type: 'text/plain' }),
        );
        await user.upload(input, files);

        expect(await screen.findByText('Not added: extra.txt')).toBeDefined();
        await waitFor(() => {
            expect(screen.getByRole('list', { name: 'Added files' }).children).toHaveLength(2);
        });
        expect(upload).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'notes.txt', purpose: 'upload' }),
            expect.anything(),
        );
        await user.click(screen.getByRole('button', { name: 'Remove plan.txt' }));
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await screen.findByRole('heading', { level: 1, name: 'Your engine is set up' });
        expect(answers).toHaveLength(1);
        expect(answers[0]?.kind === 'upload' && answers[0].fileIds).toHaveLength(1);
    });

    it('takes files with the intent when the engine allows them', async () => {
        const { client } = scripted([
            pending({
                ...base,
                id: 'p1',
                kind: 'text',
                question: 'What are you working on?',
                multiline: true,
                required: false,
                placeholder: 'For example',
                initial: '',
                attachments: true,
            }),
        ]);
        renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByRole('button', { name: 'Add files' })).toBeDefined();
    });

    it('shows the engine at work while it has no prompt', async () => {
        const { client } = scripted([{ status: 'working', deferred: false, progress: null, prompt: null }]);
        renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByText('The engine is setting things up…')).toBeDefined();
    });

    it('offers a retry when the setup cannot be loaded, and says when an answer did not arrive', async () => {
        const { client } = scripted([
            pending({ ...base, id: 'p1', kind: 'confirm', question: 'Go?', confirmLabel: 'Yes', declineLabel: 'No' }),
        ]);
        const get = vi.spyOn(client.onboarding, 'get').mockImplementation(() => problemResponse('forbidden'));
        vi.spyOn(client.onboarding, 'answer').mockImplementation(() => problemResponse('internal-error'));
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByText('The setup could not be loaded.', {}, { timeout: 10_000 })).toBeDefined();
        get.mockRestore();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        await user.click(await screen.findByRole('button', { name: 'Yes' }));
        expect(await screen.findByText('The engine did not get your answer. Try again.')).toBeDefined();
    });

    it('reads the state again when its answer was to a prompt the engine moved past', async () => {
        const { client } = scripted([
            pending({ ...base, id: 'p1', kind: 'confirm', question: 'Go?', confirmLabel: 'Yes', declineLabel: 'No' }),
        ]);
        vi.spyOn(client.onboarding, 'answer').mockImplementation(() => problemResponse('onboarding-prompt-stale'));
        const get = vi.spyOn(client.onboarding, 'get');
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: client });
        await user.click(await screen.findByRole('button', { name: 'Yes' }));
        await waitFor(() => {
            expect(get.mock.calls.length).toBeGreaterThan(1);
        });
        expect(screen.queryByText('The engine did not get your answer. Try again.')).toBeNull();
    });

    it('skips to Home on an engine without Chatter', async () => {
        const { client } = scripted(
            [pending({ ...base, id: 'p1', kind: 'confirm', question: 'Go?', confirmLabel: 'Yes', declineLabel: 'No' })],
            { withChatter: false },
        );
        const { user, router } = renderWithProviders({ path: '/onboarding', engineApi: client });
        await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/');
        });
    });
});
