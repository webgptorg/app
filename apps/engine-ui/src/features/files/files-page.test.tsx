import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { createFilesEngine, FILLER_FILES, HOSTILE_FILE_NAME } from '../../testing/files-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 30_000;
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
        await app.user.selectOptions(screen.getByLabelText('Purpose'), 'output');
        await waitFor(() => {
            expect(app.router.state.location.search).toMatchObject({ purpose: 'output' });
        });
        await app.user.selectOptions(screen.getByLabelText('Scan'), 'clean');
        await app.user.selectOptions(screen.getByLabelText('Agent'), 'agent-ada');
        await app.user.type(screen.getByLabelText('Search files'), 'PHOTO');
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
        expect(screen.getByLabelText<HTMLInputElement>('Search files').value).toBe('PHOTO');
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
        await app.user.click(screen.getByRole('button', { name: 'Clear filters' }));
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
