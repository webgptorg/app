import { KNOWN_CAPABILITIES, OnboardingStateReader, OWNER_PERMISSIONS } from '@ptbk/engine-api';
import type { OnboardingActivity, Permission } from '@ptbk/engine-api';
import type { EngineApiClient, OnboardingAnswer, OnboardingPrompt, ReadOnboardingState } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../testing/render-with-providers';
import { OneTimeValue } from '../wallet/one-time-value';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;

const base = { title: 'Setup', hint: null, error: null, canGoBack: false, details: [], alternatives: [] };

function pending(
    prompt: OnboardingPrompt,
    extra: { readonly canDefer?: boolean; readonly activity?: readonly OnboardingActivity[] } = {},
): ReadOnboardingState {
    return {
        status: 'pending',
        deferred: false,
        canDefer: extra.canDefer ?? true,
        progress: { step: 1, of: 2 },
        activity: [...(extra.activity ?? [])],
        prompt,
    };
}

const DONE: ReadOnboardingState = {
    status: 'completed',
    deferred: false,
    canDefer: true,
    progress: null,
    activity: [],
    prompt: null,
};

/** The in-memory engine for everything else, with an onboarding that serves `states` in turn and records answers. */
function scripted(
    states: readonly ReadOnboardingState[],
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
    const current = (): ReadOnboardingState => ({
        ...(states[Math.min(index, states.length - 1)] as ReadOnboardingState),
        ...(deferred ? { deferred } : {}),
    });
    const answers: OnboardingAnswer[] = [];
    const bodies: Parameters<EngineApiClient['onboarding']['answer']>[0][] = [];
    const client: EngineApiClient = {
        ...engine.client,
        onboarding: {
            get: () => Promise.resolve({ kind: 'ok', data: current() }),
            answer: (body) => {
                bodies.push(body);
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
    return { client, answers, bodies };
}

describe('onboarding prompt kinds', { timeout: TIMEOUT_MS }, () => {
    it('answers a confirm prompt with the button the member picks', async () => {
        const { client, answers } = scripted([
            pending({ ...base, id: 'p1', kind: 'confirm', question: 'Sync?', confirmLabel: 'Yes', declineLabel: 'No' }),
            DONE,
        ]);
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: client });
        await user.click(await screen.findByRole('button', { name: 'No' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Your project is set up' })).toBeDefined();
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
        await screen.findByRole('heading', { level: 1, name: 'Your project is set up' });
        expect(answers).toEqual([
            { kind: 'choice', choiceIds: ['b'] },
            { kind: 'text', text: 'Bakery', fileIds: [] },
        ]);
    });

    it('is guided by the robot, keeps Enter for new lines in a long answer, and continues on Ctrl+Enter', async () => {
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
        expect(screen.getByText(/Tell me a little about your project/)).toBeDefined();
        expect(screen.getByText('Step 1 of 2')).toBeDefined();
        await user.type(answer, 'Bread{Enter}Cakes');
        expect(answers).toEqual([]);
        await user.keyboard('{Control>}{Enter}{/Control}');
        await screen.findByRole('heading', { level: 1, name: 'Your project is set up' });
        expect(answers).toEqual([{ kind: 'text', text: 'Bread\nCakes', fileIds: [] }]);
    });

    it('guides without agents.read, and never asks for the agent list', async () => {
        const { client } = scripted(
            [pending({ ...base, id: 'p1', kind: 'confirm', question: 'Go?', confirmLabel: 'Yes', declineLabel: 'No' })],
            { permissions: OWNER_PERMISSIONS.filter((permission) => permission !== 'agents.read') },
        );
        const list = vi.spyOn(client.agents, 'list');
        renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByRole('button', { name: 'Yes' })).toBeDefined();
        expect(screen.getByText(/confirm when it seems right/)).toBeDefined();
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
        await screen.findByRole('heading', { level: 1, name: 'Your project is set up' });
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
        const { client } = scripted([
            { status: 'working', deferred: false, canDefer: true, progress: null, activity: [], prompt: null },
        ]);
        renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByText('The project is setting things up…')).toBeDefined();
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
        expect(await screen.findByText('The project did not get your answer. Try again.')).toBeDefined();
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
        expect(screen.queryByText('The project did not get your answer. Try again.')).toBeNull();
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

const SECRET = 'sk-test-0123456789abcdef';

const secretPrompt = (id: string, error: string | null = null): OnboardingPrompt => ({
    ...base,
    id,
    kind: 'secret',
    title: 'API key',
    question: 'Paste your Gemini API key.',
    hint: 'It starts with AIza.',
    label: 'Gemini API key',
    placeholder: 'AIza…',
    helpUrl: 'https://aistudio.google.com/apikey',
    error,
    canGoBack: true,
});

/** Every value the mutation cache retains, with any one-time value read out, so a kept secret would show. */
function retainedMutationValues(queryClient: QueryClient): string {
    const reveal = (value: unknown): unknown => {
        if (value instanceof OneTimeValue) return value.take();
        if (Array.isArray(value)) return value.map(reveal);
        if (typeof value === 'object' && value !== null) {
            return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, reveal(inner)]));
        }
        return value;
    };
    return JSON.stringify(
        queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => reveal(mutation.state)),
    );
}

describe('onboarding input kinds after pairing', { timeout: TIMEOUT_MS }, () => {
    it('takes a secret in a masked field, sends it once, and keeps it nowhere after a refusal', async () => {
        const { client, answers } = scripted([
            pending(secretPrompt('k1')),
            pending(secretPrompt('k2', 'This key was not accepted. Check it and paste it again.')),
        ]);
        const { user, queryClient, container } = renderWithProviders({ path: '/onboarding', engineApi: client });
        const field = await screen.findByLabelText<HTMLInputElement>('Gemini API key');
        expect(field.type).toBe('password');
        expect(field.getAttribute('autocomplete')).toBe('off');
        expect(field.getAttribute('spellcheck')).toBe('false');
        expect(field.placeholder).toBe('AIza…');
        expect(screen.getByText('It starts with AIza.')).toBeDefined();
        const help = screen.getByRole('link', { name: /Where to get it/ });
        expect(help.getAttribute('href')).toBe('https://aistudio.google.com/apikey');
        expect(help.getAttribute('rel')).toContain('noopener');
        expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);

        await user.type(field, SECRET);
        await user.click(screen.getByRole('button', { name: 'Continue' }));

        expect(await screen.findByText('This key was not accepted. Check it and paste it again.')).toBeDefined();
        expect(answers).toEqual([{ kind: 'secret', value: SECRET }]);
        const again = screen.getByLabelText<HTMLInputElement>('Gemini API key');
        expect(again.value).toBe('');
        expect(again.getAttribute('aria-invalid')).toBe('true');
        expect(field.value).toBe('');
        const inputs = [...container.querySelectorAll('input')].map((input) => input.value);
        expect(inputs.join('\n')).not.toContain(SECRET);
        expect(new XMLSerializer().serializeToString(document.body)).not.toContain(SECRET);
        expect(
            JSON.stringify(
                queryClient
                    .getQueryCache()
                    .getAll()
                    .map((query) => query.state),
            ),
        ).not.toContain(SECRET);
        expect(retainedMutationValues(queryClient)).not.toContain(SECRET);
    });

    it('empties a typed secret when the member leaves its step', async () => {
        const { client, answers, bodies } = scripted([
            pending(secretPrompt('k1')),
            pending({ ...base, id: 'p0', kind: 'confirm', question: 'Go?', confirmLabel: 'Yes', declineLabel: 'No' }),
        ]);
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: client });
        const field = await screen.findByLabelText<HTMLInputElement>('Gemini API key');
        await user.type(field, SECRET);
        await user.click(screen.getByRole('button', { name: 'Back' }));
        expect(await screen.findByRole('button', { name: 'Yes' })).toBeDefined();
        expect(field.value).toBe('');
        expect(answers).toEqual([]);
        expect(bodies).toEqual([{ promptId: 'k1', action: 'back' }]);
    });

    it('shows the engine’s facts under the question, as the review on a final confirm', async () => {
        const { client, answers } = scripted([
            pending({
                ...base,
                id: 'p1',
                kind: 'confirm',
                title: 'Review',
                question: 'Create the project and start?',
                details: [
                    { label: 'Project', text: 'Bakery' },
                    { label: 'Folder', text: '~/projects/bakery' },
                    { label: 'AI tools', text: 'OpenAI Codex' },
                ],
                confirmLabel: 'Create and start',
                declineLabel: 'Change something',
            }),
            DONE,
        ]);
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByText('Create the project and start?')).toBeDefined();
        expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual(['Project', 'Folder', 'AI tools']);
        expect(screen.getAllByRole('definition').map((value) => value.textContent)).toEqual([
            'Bakery',
            '~/projects/bakery',
            'OpenAI Codex',
        ]);
        await user.click(screen.getByRole('button', { name: 'Create and start' }));
        await screen.findByRole('heading', { level: 1, name: 'Your project is set up' });
        expect(answers).toEqual([{ kind: 'confirm', confirmed: true }]);
    });

    it('takes an alternative the engine presents next, and links one of its own pages in a new tab', async () => {
        const login: OnboardingPrompt = {
            ...base,
            id: 'l1',
            kind: 'harness-login',
            title: 'Sign in to OpenAI Codex',
            question: 'Sign in with your ChatGPT account.',
            harness: 'OpenAI Codex',
            method: 'device-code',
            url: 'https://auth.openai.com/codex/device',
            userCode: 'K7QF-3MRP',
            status: 'waiting',
            diagnostic: null,
            expiresAt: null,
            alternatives: [
                { id: 'api-key', label: 'Use an API key instead', description: 'For an organisation key.', href: null },
                {
                    id: 'terminal',
                    label: 'Sign in in a terminal instead',
                    description: null,
                    href: '/_ptbk/harness-terminal?harness=codex',
                },
            ],
        };
        const { client, bodies } = scripted([pending(login), pending(secretPrompt('k1'))]);
        const { user } = renderWithProviders({ path: '/onboarding', engineApi: client });

        const link = await screen.findByRole('link', { name: /Sign in in a terminal instead/ });
        expect(link.getAttribute('href')).toBe('/_ptbk/harness-terminal?harness=codex');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener');
        expect(screen.getByText(/come back to this page to continue/)).toBeDefined();
        expect(screen.getByText('For an organisation key.')).toBeDefined();

        await user.click(screen.getByRole('button', { name: 'Use an API key instead' }));
        expect(await screen.findByLabelText('Gemini API key')).toBeDefined();
        expect(bodies).toEqual([{ promptId: 'l1', action: 'alternative', alternativeId: 'api-key' }]);
    });

    it('lists the engine’s work while it sets up, and keeps a failure in view above the next prompt', async () => {
        const activity: OnboardingActivity[] = [
            { id: 'a1', label: 'Install OpenAI Codex', status: 'done', detail: null },
            { id: 'a2', label: 'Check Claude Code', status: 'failed', detail: 'claude: command not found' },
            { id: 'a3', label: 'Install Gemini CLI', status: 'skipped', detail: null },
            { id: 'a4', label: 'Download the model', status: 'running', detail: '240 MB of 1.2 GB' },
        ];
        const { client } = scripted([
            { status: 'working', deferred: false, canDefer: true, progress: null, activity, prompt: null },
            pending(
                {
                    ...base,
                    id: 'p1',
                    kind: 'confirm',
                    question: 'Go on with Codex?',
                    confirmLabel: 'Yes',
                    declineLabel: 'No',
                },
                { activity: activity.slice(0, 3) },
            ),
            pending(
                { ...base, id: 'p2', kind: 'confirm', question: 'All good?', confirmLabel: 'Fine', declineLabel: 'No' },
                { activity: [activity[0] as OnboardingActivity] },
            ),
        ]);
        const { user, queryClient } = renderWithProviders({ path: '/onboarding', engineApi: client });
        const list = await screen.findByRole('list', { name: 'What the project is doing' });
        const lines = within(list)
            .getAllByRole('listitem')
            .map((line) => line.textContent);
        expect(lines).toEqual([
            'Done: Install OpenAI Codex',
            'Failed: Check Claude Codeclaude: command not found',
            'Skipped: Install Gemini CLI · Skipped',
            'In progress: Download the model240 MB of 1.2 GB',
        ]);
        expect(screen.queryByText('The project is setting things up…')).toBeNull();

        await client.onboarding.answer({ promptId: 'none', action: 'back' }, AbortSignal.timeout(1_000));
        await queryClient.invalidateQueries({ queryKey: ['onboarding'] });
        expect(await screen.findByRole('button', { name: 'Yes' })).toBeDefined();
        expect(screen.getByRole('list', { name: 'What the project is doing' })).toBeDefined();
        expect(screen.getByText('claude: command not found')).toBeDefined();

        await user.click(screen.getByRole('button', { name: 'Yes' }));
        expect(await screen.findByRole('button', { name: 'Fine' })).toBeDefined();
        expect(screen.queryByRole('list', { name: 'What the project is doing' })).toBeNull();
    });

    it('offers no skip on an engine without a project yet, and says the answers are kept', async () => {
        const { client } = scripted([
            pending(
                { ...base, id: 'p1', kind: 'confirm', question: 'Go?', confirmLabel: 'Yes', declineLabel: 'No' },
                { canDefer: false },
            ),
        ]);
        renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByText(/Your answers are saved/)).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    });

    it('says a step of an unknown kind needs a newer app, names the host command, and keeps looking', async () => {
        const unknown = OnboardingStateReader.parse({
            status: 'pending',
            deferred: false,
            canDefer: false,
            progress: null,
            activity: [],
            prompt: { id: 'x1', kind: 'browser-profile', title: 'Browser profile', question: 'Which profile?' },
        });
        const { client } = scripted([unknown, DONE]);
        const get = vi.spyOn(client.onboarding, 'get');
        renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByRole('heading', { level: 1, name: 'Browser profile' })).toBeDefined();
        expect(screen.getByText('Which profile?')).toBeDefined();
        expect(screen.getByText('This step needs a newer version of the app')).toBeDefined();
        const info = await client.engine.get(AbortSignal.timeout(5_000));
        if (info.kind !== 'ok' || info.data.engineId === null) throw new Error('engine identity unavailable');
        expect(screen.getByText(`ptbk onboarding --id ${info.data.engineId}`)).toBeDefined();
        const calls = get.mock.calls.length;
        await waitFor(
            () => {
                expect(get.mock.calls.length).toBeGreaterThan(calls);
            },
            { timeout: 5_000 },
        );
    });
    it('explains how to select a saved setup when a local engine reports no ID', async () => {
        const unknown = OnboardingStateReader.parse({
            status: 'pending',
            deferred: false,
            canDefer: false,
            progress: null,
            activity: [],
            prompt: { id: 'x1', kind: 'browser-profile', title: 'Browser profile', question: 'Which profile?' },
        });
        const { client } = scripted([unknown]);
        const original = client.engine.get.bind(client.engine);
        vi.spyOn(client.engine, 'get').mockImplementation(async (signal) => {
            const result = await original(signal);
            return result.kind === 'ok' ? { ...result, data: { ...result.data, engineId: null } } : result;
        });
        renderWithProviders({ path: '/onboarding', engineApi: client });
        expect(await screen.findByText('ptbk onboarding')).toBeDefined();
        expect(screen.getByText(/If it lists setups, repeat with --id/)).toBeDefined();
        expect(screen.queryByText(/ptbk onboarding --id null/)).toBeNull();
    });
});
