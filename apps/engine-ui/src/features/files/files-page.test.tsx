import { PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { createFilesEngine, FILLER_FILES, HOSTILE_FILE_NAME } from '../../testing/files-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 30_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));
const dialog = () => screen.getByRole('dialog');
/** "+ Filter", then a field; the dialog then lists the field's values. */
async function addFilter(user: UserEvent, field: string) {
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(within(dialog()).getByRole('option', { name: field }));
}
const lastListQuery = (engine: ReturnType<typeof createFilesEngine>) => engine.spies.list.mock.calls.at(-1)?.[0];

describe('files list', { timeout: TIMEOUT_MS }, () => {
    it('lists every file newest first and pages through all of them', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/files', engineApi: engine.client });
        expect(await screen.findByRole('link', { name: 'photo.png' })).toBeDefined();
        expect(lastQuery(engine)).toEqual({ limit: 50, sort: '-createdAt' });
        expect(screen.getByRole('link', { name: 'Note 041.md' })).toBeDefined();
        await app.user.click(screen.getByRole('button', { name: 'Next page' }));
        expect(
            await screen.findByRole('link', { name: `Note ${String(FILLER_FILES).padStart(3, '0')}.md` }),
        ).toBeDefined();
        expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
        await app.user.click(screen.getByRole('button', { name: 'Previous page' }));
        expect(await screen.findByRole('link', { name: 'photo.png' })).toBeDefined();
    });

    it('sends purpose, scan, agent and search to the engine, writes them to the URL and restores them', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/files', engineApi: engine.client });
        await screen.findByRole('link', { name: 'photo.png' });
        await addFilter(app.user, 'Purpose');
        await app.user.click(within(dialog()).getByRole('option', { name: 'Output' }));
        await waitFor(() => {
            expect(app.router.state.location.search).toMatchObject({ purpose: 'output' });
        });
        await addFilter(app.user, 'Scan');
        await app.user.click(within(dialog()).getByRole('option', { name: 'Clean' }));
        await app.user.keyboard('{Escape}');
        await addFilter(app.user, 'Agent');
        await app.user.click(await within(dialog()).findByRole('option', { name: 'Ada' }));
        await app.user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'PHOTO');
        await waitFor(() => {
            expect(lastQuery(engine)).toEqual({
                limit: 50,
                sort: '-createdAt',
                purpose: 'output',
                scan: 'clean',
                agentId: 'agent-ada',
                q: 'PHOTO',
            });
        });
        expect(await screen.findByRole('link', { name: 'photo.png' })).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByRole('link', { name: 'diagram.svg' })).toBeNull();
        });
        const href = app.router.state.location.href;
        app.unmount();

        const reloaded = createFilesEngine();
        renderWithProviders({ path: href, engineApi: reloaded.client });
        expect(await screen.findByRole('link', { name: 'photo.png' })).toBeDefined();
        expect(lastQuery(reloaded)).toMatchObject({
            purpose: 'output',
            scan: 'clean',
            agentId: 'agent-ada',
            q: 'PHOTO',
        });
        expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search files' }).value).toBe('PHOTO');
        expect(screen.getAllByRole('button', { name: 'Purpose: Output' })).not.toHaveLength(0);
        expect(await screen.findAllByRole('button', { name: 'Agent: Ada' })).not.toHaveLength(0);
    });

    it('shows each file’s agent as a chip and its purpose and scan in words', async () => {
        const engine = createFilesEngine();
        renderWithProviders({ path: '/files', engineApi: engine.client });
        const name = await screen.findByRole('link', { name: 'photo.png' });
        const row = name.closest('tr') as HTMLElement;
        expect((await within(row).findByRole('link', { name: 'Ada' })).getAttribute('href')).toBe('/agents/agent-ada');
        expect(within(row).getByText('Output')).toBeDefined();
        expect(within(row).getByText('Clean')).toBeDefined();
    });

    it('opens the details and deletes from the row’s menu, never inline', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/files', engineApi: engine.client });
        await screen.findByRole('link', { name: 'photo.png' });
        expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
        await app.user.click(screen.getByRole('button', { name: 'Actions for photo.png' }));
        await app.user.click(await screen.findByRole('menuitem', { name: 'File details' }));
        expect(await screen.findByRole('dialog', { name: 'File details' })).toBeDefined();
        expect(app.router.state.location.search).toMatchObject({ file: expect.any(String) as string });
        await app.user.keyboard('{Escape}');
        await app.user.click(screen.getByRole('button', { name: 'Actions for photo.png' }));
        await app.user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        expect(await screen.findByRole('dialog', { name: 'Delete file?' })).toBeDefined();
    });

    it('offers no delete and no agent filter to a member who may not', async () => {
        const engine = createFilesEngine({ permissions: allBut('files.write', 'agents.read') });
        const app = renderWithProviders({ path: '/files', engineApi: engine.client });
        const name = await screen.findByRole('link', { name: 'photo.png' });
        const row = name.closest('tr') as HTMLElement;
        expect(within(row).getByText('agent-ada')).toBeDefined();
        expect(within(row).queryByRole('link', { name: 'agent-ada' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Upload knowledge' })).toBeNull();
        await app.user.click(screen.getByRole('button', { name: 'Actions for photo.png' }));
        expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
        await app.user.keyboard('{Escape}');
        await app.user.click(screen.getByRole('button', { name: 'Filter' }));
        expect(within(dialog()).queryByRole('option', { name: 'Agent' })).toBeNull();
        expect(within(dialog()).getByRole('option', { name: 'Purpose' })).toBeDefined();
    });

    it('filters scan problems as one set, as the attention item links to them', async () => {
        const engine = createFilesEngine();
        renderWithProviders({ path: '/files?scan=infected,failed', engineApi: engine.client });
        expect(await screen.findByRole('link', { name: 'invoice.png' })).toBeDefined();
        expect(screen.getByRole('link', { name: 'archive.docx' })).toBeDefined();
        expect(lastQuery(engine)).toMatchObject({ scan: 'infected,failed' });
        expect(screen.queryByRole('link', { name: 'photo.png' })).toBeNull();
        expect(within(screen.getByRole('table')).getByText('Infected')).toBeDefined();
        expect(within(screen.getByRole('table')).getByText('Scan failed')).toBeDefined();
        expect(screen.getAllByRole('button', { name: 'Scan: Infected, Scan failed' })).not.toHaveLength(0);
    });

    it('sorts on the engine by name and size', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/files', engineApi: engine.client });
        await screen.findByRole('link', { name: 'photo.png' });
        await app.user.click(screen.getByRole('button', { name: 'Sort by Name' }));
        await waitFor(() => {
            expect(lastQuery(engine)).toMatchObject({ sort: 'name' });
        });
        await app.user.click(screen.getByRole('button', { name: 'Sort by Size' }));
        await waitFor(() => {
            expect(lastQuery(engine)).toMatchObject({ sort: '-sizeBytes' });
        });
    });

    it('shows a hostile file name as literal text', async () => {
        const engine = createFilesEngine();
        const { container } = renderWithProviders({ path: '/files', engineApi: engine.client });
        expect(await screen.findByRole('link', { name: HOSTILE_FILE_NAME })).toBeDefined();
        expect(container.querySelector('img[src="x"]')).toBeNull();
        expect(container.querySelector('img')).toBeNull();
    });
});

describe('files list states', { timeout: TIMEOUT_MS }, () => {
    it('shows skeleton rows while the first page loads', async () => {
        const engine = createFilesEngine();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        engine.spies.list.mockImplementation(async (query, signal) => {
            await gate;
            return engine.original.list(query, signal);
        });
        const { container } = renderWithProviders({ path: '/files', engineApi: engine.client });
        await waitFor(() => {
            expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
        });
        release();
        expect(await screen.findByRole('link', { name: 'photo.png' })).toBeDefined();
    });

    it('explains an engine without files', async () => {
        const engine = createFilesEngine({ seed: { agents: [{ id: 'agent-ada', source: 'Ada\nPERSONA x' }] } });
        const { container } = renderWithProviders({ path: '/files', engineApi: engine.client });
        expect(await screen.findByText('No files yet')).toBeDefined();
        await expectNoAxeViolations(container);
    });

    it('says when nothing matches and clears the filters', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/files?q=nothing-like-this', engineApi: engine.client });
        expect(await screen.findByText('No files match your filters')).toBeDefined();
        await app.user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
        expect(await screen.findByRole('link', { name: 'photo.png' })).toBeDefined();
        expect(app.router.state.location.search).not.toHaveProperty('q');
    });

    it('shows a list failure in the table with a retry', async () => {
        const engine = createFilesEngine();
        engine.spies.list.mockImplementation(() => problemResponse('validation-failed'));
        const app = renderWithProviders({ path: '/files', engineApi: engine.client });
        expect(await screen.findByText('Could not load files')).toBeDefined();
        engine.spies.list.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('link', { name: 'photo.png' })).toBeDefined();
    });

    it('passes axe with rows and badges', async () => {
        const engine = createFilesEngine();
        const { container } = renderWithProviders({ path: '/files', engineApi: engine.client });
        await screen.findByRole('link', { name: 'photo.png' });
        await expectNoAxeViolations(container);
    });
});

function lastQuery(engine: ReturnType<typeof createFilesEngine>) {
    return lastListQuery(engine);
}
