import { AgentId, createProblem } from '@ptbk/engine-api';
import type { Diagnostic, EngineApiClient, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import {
    appendToBook,
    bookText,
    editorView,
    installEditorDomGaps,
    pressSaveShortcut,
    replaceBook,
} from '../../testing/book-editor';
import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';

// Each test renders the whole app on the in-memory engine, and validation waits for its 500 ms debounce.
const TIMEOUT_MS = 20_000;

installEditorDomGaps();
const WAIT = { timeout: 5_000 };

const AGENT = AgentId.parse('agent-ada');
const SOURCE = 'Ada\nPERSONA Research';
const READ_ONLY: readonly Permission[] = ['agents.read', 'members.read'];

type Agents = EngineApiClient['agents'];

interface Setup {
    readonly permissions?: readonly Permission[];
    /** Replaces client methods, e.g. to hold an answer back. */
    readonly agents?: Partial<Agents>;
}

function setup({ permissions, agents = {} }: Setup = {}) {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            agents: [{ id: AGENT, source: SOURCE }],
        },
        ...(permissions === undefined ? {} : { member: { id: 'member-owner', permissions, role: 'member' } }),
    });
    const real = engine.client.agents;
    const client: EngineApiClient = { ...engine.client, agents: { ...real, ...agents } };
    const spies = {
        getSource: vi.spyOn(client.agents, 'getSource'),
        validate: vi.spyOn(client.agents, 'validate'),
        updateSource: vi.spyOn(client.agents, 'updateSource'),
        listRevisions: vi.spyOn(client.agents, 'listRevisions'),
    };
    const app = renderWithProviders({ path: `/agents/${AGENT}/book`, engineApi: client });
    return { ...app, real, spies };
}

async function openEditor(options: Setup = {}) {
    const app = setup(options);
    await screen.findByTestId('book-editor', {}, WAIT);
    await waitFor(() => {
        expect(bookText()).toBe(SOURCE);
    });
    return app;
}

function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

const historyTable = () => screen.getByRole('table', { name: 'History' });
const historyRows = () => within(historyTable()).getAllByRole('row').slice(1);
const selected = () => {
    const { state } = editorView();
    return state.sliceDoc(state.selection.main.from, state.selection.main.to);
};

/** Saves an edit behind the editor's back, as another member would. */
async function saveElsewhere(real: Agents, source: string) {
    const current = await real.getSource(AGENT, AbortSignal.timeout(1_000));
    if (current.kind === 'problem') throw new Error('no source');
    await real.updateSource(AGENT, { source, baseRevisionId: current.data.revisionId }, AbortSignal.timeout(1_000));
}

describe('the book editor page', { timeout: TIMEOUT_MS }, () => {
    it('shows a skeleton while the book loads', async () => {
        const held = deferred<Awaited<ReturnType<Agents['getSource']>>>();
        setup({ agents: { getSource: () => held.promise } });

        expect(await screen.findByText('Loading…', {}, WAIT)).toBeDefined();
        expect(screen.queryByTestId('book-editor')).toBeNull();
    });

    it('shows an error with a retry when the book cannot be loaded', async () => {
        let load: Agents['getSource'] = () => Promise.resolve({ kind: 'problem', problem: createProblem('not-found') });
        const app = setup({ agents: { getSource: (agentId, signal) => load(agentId, signal) } });
        expect(await screen.findByText('The book could not be loaded.', {}, WAIT)).toBeDefined();

        load = (agentId, signal) => app.real.getSource(agentId, signal);
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        await screen.findByTestId('book-editor', {}, WAIT);
    });

    it('shows the engine diagnostics as markers and problems, and updates them as the book changes', async () => {
        const app = await openEditor();
        expect(await screen.findByText('No problems found.', {}, WAIT)).toBeDefined();

        appendToBook('\nMETA COLOR red');
        const problem = await screen.findByRole('button', { name: /META COLOR needs a #rrggbb colour/ }, WAIT);
        expect(problem.textContent).toContain('Line 3');
        expect(screen.getByText('1 problem')).toBeDefined();
        await waitFor(() => {
            expect(editorView().contentDOM.querySelector('.cm-lintRange-error')).not.toBeNull();
        });

        await app.user.click(problem);
        expect(selected()).toBe('META COLOR red');

        replaceBook(SOURCE);
        await waitFor(() => {
            expect(screen.queryByRole('button', { name: /META COLOR/ })).toBeNull();
        }, WAIT);
        expect(screen.getByText('No problems found.')).toBeDefined();
    });

    it('ignores a validation answer that arrives after a newer check started', async () => {
        const stale = deferred<Awaited<ReturnType<Agents['validate']>>>();
        const app = await openEditor();
        await waitFor(() => {
            expect(app.spies.validate).toHaveBeenCalledOnce();
        }, WAIT);
        app.spies.validate.mockImplementationOnce(() => stale.promise);

        appendToBook('\nRULE first');
        await waitFor(() => {
            expect(app.spies.validate).toHaveBeenCalledTimes(2);
        }, WAIT);
        app.spies.validate.mockImplementation((body, signal) => app.real.validate(body, signal));
        appendToBook('\nMETA COLOR red');
        await screen.findByRole('button', { name: /META COLOR needs/ }, WAIT);

        const old: Diagnostic = {
            severity: 'warning',
            code: 'stale',
            message: 'From an older text',
            range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 },
        };
        await act(async () => {
            stale.resolve({ kind: 'ok', data: [old] });
            await stale.promise;
        });
        expect(screen.queryByText('From an older text')).toBeNull();
        expect(screen.getByRole('button', { name: /META COLOR needs/ })).toBeDefined();
    });

    it('says when the book could not be checked', async () => {
        const app = await openEditor();
        await screen.findByText('No problems found.', {}, WAIT);
        app.spies.validate.mockResolvedValue({ kind: 'problem', problem: createProblem('internal-error') });

        appendToBook('\nRULE x');
        expect(
            await screen.findByText(
                'The book could not be checked just now; these results may be out of date.',
                {},
                WAIT,
            ),
        ).toBeDefined();
    });

    it('saves with the version it started from, grows the history and reports success', async () => {
        const app = await openEditor();
        const save = screen.getByRole('button', { name: 'Save' });
        expect(save.hasAttribute('disabled') || save.getAttribute('aria-disabled') === 'true').toBe(true);
        expect(await screen.findByText('All changes saved', {}, WAIT)).toBeDefined();
        await waitFor(() => {
            expect(historyRows()).toHaveLength(1);
        }, WAIT);
        const initial = await app.real.getSource(AGENT, AbortSignal.timeout(1_000));
        if (initial.kind === 'problem') throw new Error('no source');

        appendToBook('\nRULE Be kind');
        expect(screen.getByText('Unsaved changes')).toBeDefined();
        await app.user.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByText('Book saved as a new version', {}, WAIT)).toBeDefined();
        expect(app.spies.updateSource).toHaveBeenCalledWith(
            AGENT,
            { source: `${SOURCE}\nRULE Be kind`, baseRevisionId: initial.data.revisionId },
            expect.any(AbortSignal),
        );
        await waitFor(() => {
            expect(historyRows()).toHaveLength(2);
        }, WAIT);
        expect(screen.getByText('All changes saved')).toBeDefined();
    });

    it('saves with Mod-s from inside the editor', async () => {
        const app = await openEditor();
        appendToBook('\nRULE Be brief');

        pressSaveShortcut();

        expect(await screen.findByText('Book saved as a new version', {}, WAIT)).toBeDefined();
        expect(app.spies.updateSource).toHaveBeenCalledOnce();
    });

    it('refuses an invalid book: diagnostics in the editor, a failure toast and no new version', async () => {
        const app = await openEditor();
        await waitFor(() => {
            expect(historyRows()).toHaveLength(1);
        }, WAIT);
        // Without a prior check, so what is shown comes from the refused save.
        app.spies.validate.mockResolvedValue({ kind: 'ok', data: [] });
        appendToBook('\nMETA COLOR red');
        await waitFor(() => {
            expect(app.spies.validate).toHaveBeenLastCalledWith(
                { source: `${SOURCE}\nMETA COLOR red` },
                expect.any(AbortSignal),
            );
        }, WAIT);
        await screen.findByText('No problems found.', {}, WAIT);
        await app.user.click(screen.getByRole('button', { name: 'Save' }));

        expect(
            await screen.findByText('Not saved: the book has errors. They are marked in the editor.', {}, WAIT),
        ).toBeDefined();
        expect(await screen.findByRole('button', { name: /META COLOR needs/ }, WAIT)).toBeDefined();
        expect(screen.getByText('Unsaved changes')).toBeDefined();
        const revisions = await app.real.listRevisions(AGENT, {}, AbortSignal.timeout(1_000));
        expect(revisions.kind === 'ok' && revisions.data.items.length).toBe(1);
    });

    it('on a conflict offers the differences and a reload with the newer text', async () => {
        const app = await openEditor();
        await saveElsewhere(app.real, `${SOURCE}\nRULE From elsewhere`);
        appendToBook('\nRULE Mine');
        await app.user.click(screen.getByRole('button', { name: 'Save' }));

        expect(
            await screen.findByText('Not saved: the book was changed elsewhere since you opened it.', {}, WAIT),
        ).toBeDefined();
        expect(await screen.findByText('Changed elsewhere', {}, WAIT)).toBeDefined();

        await app.user.click(screen.getByRole('button', { name: 'View the differences' }));
        const dialog = await screen.findByRole('dialog', { name: 'Your text compared with the saved version' });
        await waitFor(() => {
            expect(
                within(dialog).getByTestId('book-viewer').shadowRoot?.querySelector('.cm-deletedChunk'),
            ).not.toBeNull();
        });
        expect(bookText('book-viewer')).toBe(`${SOURCE}\nRULE Mine`);
        await app.user.click(within(dialog).getByRole('button', { name: 'Close' }));

        await app.user.click(screen.getByRole('button', { name: 'Reload and discard mine' }));
        expect(bookText()).toBe(`${SOURCE}\nRULE From elsewhere`);
        expect(screen.queryByText('Changed elsewhere')).toBeNull();
        expect(screen.getByText('All changes saved')).toBeDefined();
    });

    it('restores an older version as a new one, compares it first and grows the history', async () => {
        const app = await openEditor();
        appendToBook('\nRULE Second');
        await app.user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(historyRows()).toHaveLength(2);
        }, WAIT);

        const [newest, oldest] = historyRows();
        expect(within(newest as HTMLElement).getByText('Current')).toBeDefined();
        expect(within(newest as HTMLElement).queryByRole('button', { name: 'Restore this version' })).toBeNull();
        await app.user.click(within(oldest as HTMLElement).getByRole('button', { name: 'View' }));
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => {
            expect(bookText('book-viewer')).toBe(SOURCE);
        });
        await app.user.click(within(dialog).getByRole('button', { name: 'Compare with current' }));
        expect(within(dialog).getByRole('button', { name: 'Compare with current' }).getAttribute('aria-pressed')).toBe(
            'true',
        );
        await waitFor(() => {
            expect(
                within(dialog).getByTestId('book-viewer').shadowRoot?.querySelector('.cm-deletedChunk'),
            ).not.toBeNull();
        });

        await app.user.click(within(dialog).getByRole('button', { name: 'Restore this version' }));
        expect(await screen.findByText('Version restored as a new version', {}, WAIT)).toBeDefined();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(bookText()).toBe(SOURCE);
        await waitFor(() => {
            expect(historyRows()).toHaveLength(3);
        }, WAIT);
        const current = await app.real.getSource(AGENT, AbortSignal.timeout(1_000));
        expect(current.kind === 'ok' && current.data.source).toBe(SOURCE);
    });

    it('warns that a restore replaces unsaved changes, and reports a failed restore', async () => {
        const app = await openEditor();
        appendToBook('\nRULE Second');
        await app.user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(historyRows()).toHaveLength(2);
        }, WAIT);
        appendToBook('\nRULE Unsaved');
        app.spies.updateSource.mockResolvedValueOnce({ kind: 'problem', problem: createProblem('internal-error') });

        await app.user.click(within(historyRows()[1] as HTMLElement).getByRole('button', { name: 'View' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('Restoring replaces your unsaved changes in the editor.')).toBeDefined();
        await app.user.click(within(dialog).getByRole('button', { name: 'Restore this version' }));

        expect(
            await screen.findByText('The version could not be restored. Nothing changed; try again.', {}, WAIT),
        ).toBeDefined();
        expect(bookText()).toBe(`${SOURCE}\nRULE Second\nRULE Unsaved`);
    });

    it('pages through a long history with cursors', async () => {
        const app = await openEditor();
        for (let index = 1; index <= 21; index += 1)
            await saveElsewhere(app.real, `${SOURCE}\nRULE Version ${String(index)}`);
        await app.queryClient.invalidateQueries({ queryKey: ['book', 'revisions'] });
        await waitFor(() => {
            expect(historyRows()).toHaveLength(20);
        }, WAIT);

        await app.user.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() => {
            expect(historyRows()).toHaveLength(2);
        }, WAIT);
        const query = app.spies.listRevisions.mock.lastCall?.[1];
        expect(query?.limit).toBe(20);
        expect(typeof query?.cursor).toBe('string');
        await app.user.click(screen.getByRole('button', { name: 'Previous page' }));
        await waitFor(() => {
            expect(historyRows()).toHaveLength(20);
        }, WAIT);
    });

    it('shows an empty history and a history error with a retry', async () => {
        let fail = true;
        const app = setup({
            agents: {
                listRevisions: () =>
                    Promise.resolve(
                        fail
                            ? { kind: 'problem', problem: createProblem('internal-error') }
                            : { kind: 'ok', data: { items: [], nextCursor: null } },
                    ),
            },
        });
        expect(await screen.findByText('The history could not be loaded.', {}, WAIT)).toBeDefined();
        fail = false;
        await app.user.click(
            within(screen.getByRole('region', { name: 'History' })).getByRole('button', { name: 'Try again' }),
        );
        expect(await screen.findByText('No versions yet', {}, WAIT)).toBeDefined();
    });

    it('lets a member without agents.write read the book and its history, but not save or restore', async () => {
        const app = await openEditor({ permissions: READ_ONLY });
        expect(screen.getByText('You can read this book but not change it.')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Problems' })).toBeNull();
        expect(editorView().state.readOnly).toBe(true);
        expect(editorView().contentDOM.getAttribute('aria-readonly')).toBe('true');
        expect(app.spies.validate).not.toHaveBeenCalled();

        await waitFor(() => {
            expect(historyRows()).toHaveLength(1);
        }, WAIT);
        await app.user.click(within(historyRows()[0] as HTMLElement).getByRole('button', { name: 'View' }));
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => {
            expect(bookText('book-viewer')).toBe(SOURCE);
        });
        expect(within(dialog).queryByRole('button', { name: 'Restore this version' })).toBeNull();
    });

    it('asks before leaving with unsaved changes', async () => {
        const app = await openEditor();
        appendToBook('\nRULE Unsaved');

        await app.user.click(screen.getByRole('tab', { name: 'Overview' }));
        const confirm = await screen.findByRole('dialog', { name: 'Leave without saving?' });
        await app.user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
        expect(app.router.state.location.pathname).toBe(`/agents/${AGENT}/book`);

        await app.user.click(screen.getByRole('tab', { name: 'Overview' }));
        await app.user.click(
            within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole('button', {
                name: 'Leave and lose changes',
            }),
        );
        await waitFor(() => {
            expect(app.router.state.location.pathname).toBe(`/agents/${AGENT}`);
        });
    });

    it('is keyboard-operable and has no axe violations', async () => {
        await openEditor();
        appendToBook('\nMETA COLOR red');
        await screen.findByRole('button', { name: /META COLOR needs/ }, WAIT);
        await waitFor(() => {
            expect(historyRows()).toHaveLength(1);
        }, WAIT);

        expect(editorView().contentDOM.getAttribute('aria-label')).toBe('Book source');
        expect(editorView().contentDOM.getAttribute('contenteditable')).toBe('true');
        await expectNoAxeViolations(document.body);
    });
});
