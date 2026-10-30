import { createProblem, PERMISSIONS } from '@ptbk/engine-api';
import type {
    CapabilityRef,
    EngineApiClient,
    EngineApiResponse,
    FileMetadata,
    Permission,
    UploadOptions,
} from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { bookText, editorView, installEditorDomGaps, replaceBook } from '../../testing/book-editor';
import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';
import { TEST_UPLOAD_POLICIES } from '../../testing/files-engine';
import { bookTemplate } from './book-template';

// Each test renders the whole app on the in-memory engine, and validation waits for its 500 ms debounce.
const TIMEOUT_MS = 20_000;

installEditorDomGaps();
const WAIT = { timeout: 5_000 };

interface Setup {
    readonly path?: string;
    readonly permissions?: readonly Permission[];
    readonly capabilities?: readonly CapabilityRef[];
    readonly agents?: Partial<EngineApiClient['agents']>;
}

function setup({ path = '/agents/new', permissions, capabilities, agents = {} }: Setup = {}) {
    const engine = createInMemoryEngine({
        uploadPolicies: TEST_UPLOAD_POLICIES,
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            agents: [{ id: 'agent-ada', source: 'Ada\nPERSONA Research' }],
        },
        ...(permissions === undefined ? {} : { member: { id: 'member-owner', permissions, role: 'member' } }),
        ...(capabilities === undefined ? {} : { capabilities }),
    });
    const real = engine.client.agents;
    const client: EngineApiClient = {
        ...engine.client,
        agents: { ...real, ...agents },
        files: { ...engine.client.files },
        chats: { ...engine.client.chats },
    };
    const spies = {
        upload: vi.spyOn(client.files, 'upload'),
        create: vi.spyOn(client.agents, 'create'),
        validate: vi.spyOn(client.agents, 'validate'),
        delete: vi.spyOn(client.agents, 'delete'),
        createChat: vi.spyOn(client.chats, 'create'),
    };
    const app = renderWithProviders({ path, engineApi: client });
    return { ...app, real, spies };
}

type App = ReturnType<typeof setup>;

const search = (app: App) => app.router.state.location.search as Record<string, unknown>;
const stepHeading = (name: string) => screen.findByRole('heading', { level: 2, name }, WAIT);

async function fillBrief(app: App, name = 'Iris', description = 'Writes the weekly report') {
    await stepHeading('Describe your agent');
    await app.user.type(screen.getByRole('textbox', { name: /^Name/ }), name);
    if (description !== '') await app.user.type(screen.getByRole('textbox', { name: /^What it does/ }), description);
    await app.user.click(screen.getByRole('button', { name: 'Next' }));
    await stepHeading('Write its book');
    await screen.findByTestId('book-editor', {}, WAIT);
}

async function createAgent(app: App) {
    await fillBrief(app);
    await app.user.click(screen.getByRole('button', { name: 'Create agent' }));
    await stepHeading('Add knowledge');
}

/** Engines without throwaway test chats: the test step falls back to a kept chat. */
const NO_TEST_CHAT: readonly CapabilityRef[] = [];

async function expectFinishedOnOverview(app: App, agentId: string) {
    // The last step only finishes: there is nothing left to finish later.
    expect(screen.queryByRole('button', { name: 'Finish later' })).toBeNull();
    await app.user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(await screen.findByText('Iris is ready', {}, WAIT)).toBeDefined();
    await waitFor(() => {
        expect(app.router.state.location.pathname).toBe(`/agents/${agentId}`);
    });
}

describe('the create-agent wizard', { timeout: TIMEOUT_MS }, () => {
    it('needs agents.write', async () => {
        setup({ permissions: PERMISSIONS.filter((permission) => permission !== 'agents.write') });
        expect(await screen.findByRole('heading', { name: 'No access' }, WAIT)).toBeDefined();
    });

    it('blocks the brief step until it is valid, and keeps the step in the URL', async () => {
        const app = setup();
        await stepHeading('Describe your agent');
        await app.user.click(screen.getByRole('button', { name: 'Next' }));

        expect(await screen.findByText('Give the agent a name.')).toBeDefined();
        expect(screen.getByRole('textbox', { name: /^Name/ }).getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByRole('heading', { level: 2, name: 'Describe your agent' })).toBeDefined();
        expect(search(app)['step']).toBe('brief');
        expect(app.spies.create).not.toHaveBeenCalled();
    });

    it('drafts the book from the brief, moves focus to each step heading and keeps an edited draft', async () => {
        const app = setup();
        await fillBrief(app);

        expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Write its book' }));
        expect(search(app)['step']).toBe('book');
        expect(bookText()).toBe(bookTemplate({ name: 'Iris', description: 'Writes the weekly report' }));
        const current = screen.getByRole('list', { name: 'Steps' }).querySelector('[aria-current="step"]');
        expect(current?.textContent).toMatch(/Book$/);
        expect(screen.getAllByRole('listitem').filter((item) => item.closest('ol[aria-label="Steps"]'))).toHaveLength(
            4,
        );
        expect(screen.getByText('Step 2 of 4 · Book')).toBeDefined();

        await app.user.click(screen.getByRole('button', { name: 'Back' }));
        expect(document.activeElement).toBe(await stepHeading('Describe your agent'));
        await app.user.type(screen.getByRole('textbox', { name: /^Name/ }), ' Two');
        await app.user.click(screen.getByRole('button', { name: 'Next' }));
        await screen.findByTestId('book-editor', {}, WAIT);
        expect(bookText().split('\n')[0]).toBe('Iris Two');

        replaceBook('Iris\nPERSONA Mine');
        await app.user.click(screen.getByRole('button', { name: 'Back' }));
        await app.user.click(await screen.findByRole('button', { name: 'Next' }));
        await screen.findByTestId('book-editor', {}, WAIT);
        expect(bookText()).toBe('Iris\nPERSONA Mine');
    });

    it('creates the agent exactly once however often "Create agent" is pressed', async () => {
        const app = setup();
        await fillBrief(app);
        const create = screen.getByRole('button', { name: 'Create agent' });

        await app.user.dblClick(create);
        await app.user.click(create);

        await stepHeading('Add knowledge');
        expect(app.spies.create).toHaveBeenCalledOnce();
        expect(await screen.findByText('Iris created', {}, WAIT)).toBeDefined();
        expect(search(app)['agent']).toBeDefined();
        const listed = await app.real.list({ q: 'Iris' }, AbortSignal.timeout(1_000));
        expect(listed.kind === 'ok' && listed.data.items.map((agent) => agent.name)).toEqual(['Iris']);
    });

    it('keeps the member on the book step with its diagnostics when the engine refuses the book', async () => {
        const app = setup({ agents: { validate: () => Promise.resolve({ kind: 'ok', data: [] }) } });
        await fillBrief(app);
        replaceBook('Iris\nMETA COLOR red');
        await app.user.click(screen.getByRole('button', { name: 'Create agent' }));

        expect(
            await screen.findByText('Not created: the book has errors. They are marked in the editor.', {}, WAIT),
        ).toBeDefined();
        expect(await screen.findByRole('button', { name: /META COLOR needs/ }, WAIT)).toBeDefined();
        expect(screen.getByRole('heading', { level: 2, name: 'Write its book' })).toBeDefined();
        expect(search(app)['agent']).toBeUndefined();

        replaceBook('Iris\nMETA COLOR #00ff00');
        await app.user.click(screen.getByRole('button', { name: 'Create agent' }));
        await stepHeading('Add knowledge');
        expect(app.spies.create).toHaveBeenCalledTimes(2);
    });

    it('reports any other failure to create, lets the member retry, and jumps to a problem from the list', async () => {
        let fail = true;
        const app = setup();
        app.spies.create.mockImplementation((body, signal) =>
            fail
                ? Promise.resolve({ kind: 'problem', problem: createProblem('internal-error') })
                : app.real.create(body, signal),
        );
        await fillBrief(app);
        replaceBook('Iris\nMETA COLOR red');
        const problem = await screen.findByRole('button', { name: /META COLOR needs/ }, WAIT);
        await app.user.click(problem);
        expect(
            editorView().state.sliceDoc(editorView().state.selection.main.from, editorView().state.selection.main.to),
        ).toBe('META COLOR red');

        replaceBook('Iris\nPERSONA Writes');
        await app.user.click(screen.getByRole('button', { name: 'Create agent' }));
        expect(
            await screen.findByText('The agent could not be created. Nothing was saved; try again.', {}, WAIT),
        ).toBeDefined();
        fail = false;
        await app.user.click(screen.getByRole('button', { name: 'Create agent' }));
        await stepHeading('Add knowledge');
    });

    it('reports a create call that got no answer and stays on the book step', async () => {
        const app = setup({ agents: { create: () => Promise.reject(new TypeError('Failed to fetch')) } });
        await fillBrief(app);
        await app.user.click(screen.getByRole('button', { name: 'Create agent' }));

        expect(
            await screen.findByText('The agent could not be created. Nothing was saved; try again.', {}, WAIT),
        ).toBeDefined();
        expect(screen.getByRole('heading', { level: 2, name: 'Write its book' })).toBeDefined();
        expect(search(app)['agent']).toBeUndefined();
    });

    it('maps field errors of the create call onto the brief and lists the rest', async () => {
        const app = setup({
            agents: {
                create: () =>
                    Promise.resolve({
                        kind: 'problem',
                        problem: createProblem('validation-failed', {
                            errors: [
                                { path: 'name', message: 'That name is taken.' },
                                { path: '/source', message: 'The book is too long.' },
                            ],
                        }),
                    }),
            },
        });
        await fillBrief(app);
        await app.user.click(screen.getByRole('button', { name: 'Create agent' }));

        await stepHeading('Describe your agent');
        expect(await screen.findByText('That name is taken.')).toBeDefined();
        expect(screen.getByText('The book is too long.')).toBeDefined();
        expect(screen.getByRole('textbox', { name: /^Name/ }).getAttribute('aria-invalid')).toBe('true');
    });

    it('starts over when the URL points past what this page still holds', async () => {
        const app = setup({ path: '/agents/new?step=book' });
        await stepHeading('Describe your agent');
        await waitFor(() => {
            expect(search(app)['step']).toBe('brief');
        });

        const later = setup({ path: '/agents/new?step=done' });
        await waitFor(() => {
            expect(search(later)['step']).toBe('brief');
        });
    });

    it('leaves at once before anything is entered, and asks first once something is', async () => {
        const app = setup();
        await stepHeading('Describe your agent');
        await app.user.type(screen.getByRole('textbox', { name: /^Name/ }), 'Iris');
        await app.user.click(screen.getByRole('button', { name: 'Cancel' }));
        const confirm = await screen.findByRole('dialog', { name: 'Leave without saving?' });
        await app.user.click(within(confirm).getByRole('button', { name: 'Leave and lose changes' }));
        await waitFor(() => {
            expect(app.router.state.location.pathname).toBe('/agents');
        });

        const fresh = setup();
        await stepHeading('Describe your agent');
        await fresh.user.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1) as HTMLElement);
        await waitFor(() => {
            expect(fresh.router.state.location.pathname).toBe('/agents');
        });
    });

    it('offers to finish later or delete the created agent, under its own name', async () => {
        const app = setup();
        await createAgent(app);
        const agentId = search(app)['agent'];
        expect(screen.getByRole('heading', { level: 1, name: 'Set up Iris' })).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();

        await app.user.click(screen.getByRole('button', { name: 'Finish later' }));
        const dialog = await screen.findByRole('dialog', { name: 'Finish later?' });
        expect(within(dialog).getByText(/Iris is saved as it is/)).toBeDefined();
        await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(app.spies.delete).not.toHaveBeenCalled();

        await app.user.click(screen.getByRole('button', { name: 'Finish later' }));
        await app.user.click(
            within(await screen.findByRole('dialog', { name: 'Finish later?' })).getByRole('button', {
                name: 'Delete Iris',
            }),
        );
        expect(await screen.findByText('Iris deleted', {}, WAIT)).toBeDefined();
        expect(app.spies.delete).toHaveBeenCalledWith(agentId, expect.any(AbortSignal));
        await waitFor(() => {
            expect(app.router.state.location.pathname).toBe('/agents');
        });
    });

    it('goes to the created agent when finishing later, and hides delete without agents.delete', async () => {
        const app = setup({ permissions: PERMISSIONS.filter((permission) => permission !== 'agents.delete') });
        await createAgent(app);
        const agentId = String(search(app)['agent']);

        await app.user.click(screen.getByRole('button', { name: 'Finish later' }));
        const dialog = await screen.findByRole('dialog', { name: 'Finish later?' });
        expect(within(dialog).queryByRole('button', { name: 'Delete Iris' })).toBeNull();
        await app.user.click(within(dialog).getByRole('button', { name: 'Go to agent' }));
        await waitFor(() => {
            expect(app.router.state.location.pathname).toBe(`/agents/${agentId}`);
        });
        expect(screen.queryByText('Iris is ready')).toBeNull();
    });

    it('uploads knowledge to the new agent with progress, refuses an over-limit file and reports a failure', async () => {
        const app = setup();
        await createAgent(app);
        const agentId = String(search(app)['agent']);
        await screen.findByRole('button', { name: 'Choose files' }, WAIT);
        const input = document.querySelector<HTMLInputElement>('input[type="file"]');
        if (input === null) throw new Error('no file input');
        let progress: UploadOptions['onProgress'];
        let finish: (response: EngineApiResponse<FileMetadata>) => void = () => undefined;
        app.spies.upload.mockImplementationOnce(
            (_, __, options) =>
                new Promise((resolve) => {
                    progress = options?.onProgress;
                    finish = resolve;
                }),
        );

        expect(screen.getByRole('button', { name: 'Skip' })).toBeDefined();
        await app.user.upload(input, new File(['# Guide'], 'guide.md'));
        const list = await screen.findByRole('list', { name: 'Uploads' });
        await waitFor(() => {
            expect(progress).toBeDefined();
        });
        progress?.({ loadedBytes: 30, totalBytes: 120 });
        const bar = await within(list).findByRole('progressbar', { name: 'Upload progress of guide.md' });
        await waitFor(() => {
            expect(bar.getAttribute('value')).toBe('30');
        });
        expect(app.spies.upload.mock.calls[0]?.[0]).toMatchObject({ purpose: 'knowledge', agentId, name: 'guide.md' });
        finish({ kind: 'problem', problem: createProblem('internal-error') });
        expect(await within(list).findByText('Upload failed')).toBeDefined();

        await app.user.upload(input, new File(['x'.repeat(1001)], 'big.md'));
        expect(await within(list).findByText(/^Too large: the engine accepts up to/)).toBeDefined();
        expect(app.spies.upload).toHaveBeenCalledOnce();

        await app.user.upload(input, new File(['# Prices'], 'prices.md'));
        expect(await within(list).findByText('Uploaded', {}, WAIT)).toBeDefined();
        const files = await app.engineApi.files.list({ agentId: agentId as never }, AbortSignal.timeout(1_000));
        expect(files.kind === 'ok' && files.data.items.map((file) => file.name)).toEqual(['prices.md']);
        expect(await screen.findByRole('button', { name: 'Next' }, WAIT)).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
        await expectNoAxeViolations(document.body);
    });

    it('tests the new agent in a throwaway chat that creates no chat, and finishes on its overview', async () => {
        const app = setup();
        await createAgent(app);
        const agentId = String(search(app)['agent']);
        await app.user.click(screen.getByRole('button', { name: 'Skip' }));

        expect(document.activeElement).toBe(await stepHeading('Try it out'));
        const panel = await screen.findByTestId('book-test-chat', {}, WAIT);
        expect(within(panel).getByText(/These messages are not kept/)).toBeDefined();
        await app.user.type(within(panel).getByRole('textbox', { name: 'Message' }), 'Hello{Enter}');
        await waitFor(() => {
            expect(panel.querySelector('[aria-live="polite"][aria-atomic="true"]')?.textContent).toBe('Iris replied');
        }, WAIT);
        expect(app.spies.createChat).not.toHaveBeenCalled();
        expect(search(app)['chat']).toBeUndefined();

        await app.user.click(screen.getByRole('button', { name: 'Back' }));
        await stepHeading('Add knowledge');
        await app.user.click(screen.getByRole('button', { name: 'Skip' }));
        await stepHeading('Try it out');
        await expectFinishedOnOverview(app, agentId);
        const chats = await app.engineApi.chats.list(agentId as never, {}, AbortSignal.timeout(1_000));
        expect(chats.kind === 'ok' && chats.data.items).toEqual([]);
    });

    it('falls back to a kept chat without throwaway test chats, and says when knowledge cannot be added', async () => {
        const app = setup({ capabilities: NO_TEST_CHAT });
        await createAgent(app);
        const agentId = String(search(app)['agent']);
        expect(screen.getByText(/Knowledge files are not available here/)).toBeDefined();
        await app.user.click(screen.getByRole('button', { name: 'Next' }));

        expect(document.activeElement).toBe(await stepHeading('Try it out'));
        expect(screen.getByText(/The chat is kept with its other chats/)).toBeDefined();
        expect(screen.queryByTestId('book-test-chat')).toBeNull();
        await app.user.click(screen.getByRole('button', { name: 'Start a test chat' }));
        expect(await screen.findByRole('textbox', { name: 'Message' }, WAIT)).toBeDefined();
        expect(search(app)['chat']).toBeDefined();
        expect(app.spies.createChat).toHaveBeenCalledOnce();
        await expectFinishedOnOverview(app, agentId);
    });

    it('offers a retry when the kept test chat cannot be loaded', async () => {
        const app = setup({ capabilities: NO_TEST_CHAT });
        await createAgent(app);
        await app.user.click(screen.getByRole('button', { name: 'Next' }));
        await stepHeading('Try it out');
        const getChat = vi
            .spyOn(app.engineApi.chats, 'get')
            .mockResolvedValue({ kind: 'problem', problem: createProblem('internal-error') });
        await app.user.click(screen.getByRole('button', { name: 'Start a test chat' }));

        expect(await screen.findByText('The test chat could not be loaded.', {}, WAIT)).toBeDefined();
        getChat.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('textbox', { name: 'Message' }, WAIT)).toBeDefined();
    });

    it('offers a retry when the book to test cannot be loaded', async () => {
        const app = setup();
        await createAgent(app);
        const getSource = vi
            .spyOn(app.engineApi.agents, 'getSource')
            .mockResolvedValue({ kind: 'problem', problem: createProblem('internal-error') });
        await app.user.click(screen.getByRole('button', { name: 'Skip' }));
        await stepHeading('Try it out');

        expect(await screen.findByText('The test chat could not be loaded.', {}, WAIT)).toBeDefined();
        getSource.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('book-test-chat', {}, WAIT)).toBeDefined();
    });

    it('explains the kept test chat to a member who may not use chats, and can still finish', async () => {
        const app = setup({
            capabilities: NO_TEST_CHAT,
            permissions: PERMISSIONS.filter(
                (permission) => permission !== 'chats.write' && permission !== 'chats.read',
            ),
        });
        await createAgent(app);
        const agentId = String(search(app)['agent']);
        await app.user.click(screen.getByRole('button', { name: 'Next' }));
        await stepHeading('Try it out');
        expect(screen.getByText('Your role does not allow starting chats. You can continue.')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Start a test chat' })).toBeNull();
        await expectFinishedOnOverview(app, agentId);
    });

    it('has no axe violations on the brief and book steps', async () => {
        const app = setup();
        await stepHeading('Describe your agent');
        await expectNoAxeViolations(document.body);
        await fillBrief(app);
        await screen.findByText('No problems found.', {}, WAIT);
        await expectNoAxeViolations(document.body);
    });
});
