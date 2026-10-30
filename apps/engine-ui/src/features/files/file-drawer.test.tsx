import { KNOWN_CAPABILITIES, PERMISSIONS } from '@ptbk/engine-api';
import type { FileMetadata, Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { COMMITS, createFilesEngine, FILE_IDS, HOSTILE_FILE_NAME, PROJECT_RUN_ID } from '../../testing/files-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 30_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

async function openDrawer(fileId: string, options: Parameters<typeof createFilesEngine>[0] = {}) {
    const engine = createFilesEngine(options);
    const app = renderWithProviders({ path: `/files?file=${fileId}`, engineApi: engine.client });
    const drawer = await screen.findByRole('dialog', { name: 'File details' });
    await within(drawer).findByText('SHA-256');
    return { engine, app, drawer };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('file drawer', { timeout: TIMEOUT_MS }, () => {
    it('opens from the list, is in the URL, survives a reload and closes with the back button', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/files', engineApi: engine.client });
        await app.user.click(await screen.findByRole('link', { name: 'report.pdf' }));
        const drawer = await screen.findByRole('dialog', { name: 'File details' });
        expect(await within(drawer).findByText('application/pdf')).toBeDefined();
        expect(app.router.state.location.search).toMatchObject({ file: FILE_IDS.pdf });
        app.router.history.back();
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'File details' })).toBeNull();
        });
    });

    it('shows metadata, the SHA-256 with copy, the scan and where the file came from', async () => {
        const { drawer, app } = await openDrawer(FILE_IDS.project);
        expect(within(drawer).getByText('src/app.ts', { selector: 'p' })).toBeDefined();
        expect(within(drawer).getByText('Output')).toBeDefined();
        expect(within(drawer).getByText('Clean')).toBeDefined();
        await app.user.click(within(drawer).getByText('Technical details'));
        expect(within(drawer).getByRole('button', { name: 'Copy SHA-256' })).toBeDefined();
        expect(await within(drawer).findByRole('link', { name: 'Ada' })).toBeDefined();
        await expectNoAxeViolations(drawer);
    });

    it('lists versions with commit hashes and run links, each downloadable', async () => {
        const { drawer } = await openDrawer(FILE_IDS.project);
        const versions = await within(drawer).findByRole('list', { name: 'Versions' });
        const items = within(versions).getAllByRole('listitem');
        expect(items).toHaveLength(2);
        expect(within(items[0] as HTMLElement).getByText('Current version')).toBeDefined();
        expect(within(versions).getByText(COMMITS.second)).toBeDefined();
        expect(within(versions).getByText(COMMITS.first)).toBeDefined();
        const runLinks = within(versions).getAllByRole('link', { name: PROJECT_RUN_ID });
        expect(runLinks[0]?.getAttribute('href')).toBe(`/runs/${PROJECT_RUN_ID}`);
        const download = within(items[1] as HTMLElement).getByRole('link', { name: /^Download src\/app\.ts as of/ });
        expect(download.getAttribute('href')).toBe(
            `/api/v1/files/${FILE_IDS.project}/content?version=version-project-1`,
        );
    });

    it('hides run links when the engine does not advertise runs@1', async () => {
        const { drawer } = await openDrawer(FILE_IDS.project, { capabilities: [KNOWN_CAPABILITIES.files] });
        const versions = await within(drawer).findByRole('list', { name: 'Versions' });
        expect(within(versions).getByText(COMMITS.second)).toBeDefined();
        expect(within(drawer).queryByRole('link', { name: PROJECT_RUN_ID })).toBeNull();
        expect(within(drawer).queryByText('Run')).toBeNull();
    });

    it('says when the file is gone', async () => {
        const engine = createFilesEngine();
        renderWithProviders({ path: '/files?file=file-missing', engineApi: engine.client });
        const drawer = await screen.findByRole('dialog', { name: 'File details' });
        expect(await within(drawer).findByText('This file does not exist, or you cannot see it.')).toBeDefined();
    });

    it('offers a retry when the details or the versions cannot be loaded', async () => {
        const engine = createFilesEngine();
        engine.spies.get.mockImplementation(() => problemResponse('validation-failed'));
        engine.spies.listVersions.mockImplementation(() => problemResponse('validation-failed'));
        const app = renderWithProviders({ path: `/files?file=${FILE_IDS.pdf}`, engineApi: engine.client });
        const drawer = await screen.findByRole('dialog', { name: 'File details' });
        expect(await within(drawer).findByText('Could not load this file')).toBeDefined();
        engine.spies.get.mockRestore();
        await app.user.click(within(drawer).getByRole('button', { name: 'Try again' }));
        expect(await within(drawer).findByText('Could not load the versions')).toBeDefined();
        engine.spies.listVersions.mockRestore();
        await app.user.click(within(drawer).getByRole('button', { name: 'Try again' }));
        expect(await within(drawer).findByRole('list', { name: 'Versions' })).toBeDefined();
    });
});

describe('previews', { timeout: TIMEOUT_MS }, () => {
    it('shows a clean PNG as an <img> from the content route, sized, with the name as alt text', async () => {
        const { drawer } = await openDrawer(FILE_IDS.photo);
        const image = within(drawer).getByRole('img', { name: 'photo.png' });
        expect(image.getAttribute('src')).toBe(`/api/v1/files/${FILE_IDS.photo}/content`);
        expect(image.getAttribute('width')).toBe('320');
        expect(image.getAttribute('height')).toBe('240');
    });

    it.each([
        ['an SVG', FILE_IDS.svg],
        ['HTML', FILE_IDS.html],
        ['a PDF', FILE_IDS.pdf],
        ['an infected PNG', FILE_IDS.infected],
    ])('renders no img, iframe or object for %s', async (_, fileId) => {
        const { drawer } = await openDrawer(fileId);
        expect(drawer.querySelector('img, iframe, object, embed')).toBeNull();
    });

    it('keeps a hostile name as alt text and heading text', async () => {
        const { drawer } = await openDrawer(FILE_IDS.hostile);
        expect(within(drawer).getByText(HOSTILE_FILE_NAME, { selector: 'p' })).toBeDefined();
        expect(within(drawer).getByRole('img', { name: HOSTILE_FILE_NAME }).getAttribute('src')).toBe(
            `/api/v1/files/${FILE_IDS.hostile}/content`,
        );
        expect(drawer.querySelector('img[src="x"]')).toBeNull();
    });
});

describe('download', { timeout: TIMEOUT_MS }, () => {
    it('is disabled with the reason for an infected file, never colour alone', async () => {
        const { drawer } = await openDrawer(FILE_IDS.infected);
        const button = within(drawer).getByRole('button', { name: 'Download invoice.png' });
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(within(drawer).getAllByText(/found this file infected/).length).toBeGreaterThan(0);
        expect(within(drawer).getByText('Infected')).toBeDefined();
        expect(drawer.querySelector('a[href*="/content"]')).toBeNull();
    });

    it('is a plain same-origin link that downloads once the engine confirms the file is not infected', async () => {
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        const { drawer, app, engine } = await openDrawer(FILE_IDS.pdf);
        const link = within(drawer).getByRole('link', { name: 'Download report.pdf' });
        expect(link.getAttribute('href')).toBe(`/api/v1/files/${FILE_IDS.pdf}/content`);
        expect(link.getAttribute('download')).toBe('report.pdf');
        const calls = engine.spies.get.mock.calls.length;
        await app.user.click(link);
        await waitFor(() => {
            expect(click).toHaveBeenCalledTimes(1);
        });
        expect(engine.spies.get.mock.calls.length).toBe(calls + 1);
        expect(engine.spies.download).not.toHaveBeenCalled();
    });

    it('shows that a file turned infected since it was listed, and does not download it', async () => {
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        const { drawer, app, engine } = await openDrawer(FILE_IDS.pdf);
        const infected = async (): Promise<{ kind: 'ok'; data: FileMetadata }> => {
            const current = await engine.original.get(FILE_IDS.pdf as FileMetadata['id'], AbortSignal.timeout(1000));
            if (current.kind !== 'ok') throw new Error('no file');
            return { kind: 'ok', data: { ...current.data, scan: { status: 'infected', checkedAt: null } } };
        };
        engine.spies.get.mockImplementation(infected);
        await app.user.click(within(drawer).getByRole('link', { name: 'Download report.pdf' }));
        expect(
            await within(drawer).findAllByText('The virus scan found this file infected, so it cannot be downloaded.'),
        ).not.toHaveLength(0);
        expect(click).not.toHaveBeenCalled();
        expect(within(drawer).getByRole('button', { name: 'Download report.pdf' }).getAttribute('aria-disabled')).toBe(
            'true',
        );
    });

    it('says when the file is gone or cannot be checked, and does not download', async () => {
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        const { drawer, app, engine } = await openDrawer(FILE_IDS.pdf);
        engine.spies.get.mockImplementation(() => problemResponse('not-found'));
        await app.user.click(within(drawer).getByRole('link', { name: 'Download report.pdf' }));
        expect(await within(drawer).findByText('This file no longer exists.')).toBeDefined();
        engine.spies.get.mockImplementation(() => Promise.reject(new TypeError('offline')));
        await app.user.click(within(drawer).getByRole('link', { name: 'Download report.pdf' }));
        expect(
            await within(drawer).findByText('Could not check the file before downloading. Try again.'),
        ).toBeDefined();
        expect(click).not.toHaveBeenCalled();
    });
});

describe('delete', { timeout: TIMEOUT_MS }, () => {
    it('asks naming the file, waits for the engine, closes the drawer and confirms with a toast', async () => {
        const { drawer, app, engine } = await openDrawer(FILE_IDS.pdf);
        await app.user.click(within(drawer).getByRole('button', { name: 'Delete' }));
        const confirm = await screen.findByRole('dialog', { name: 'Delete file?' });
        expect(within(confirm).getByText(/report\.pdf and all its versions/)).toBeDefined();
        await app.user.click(within(confirm).getByRole('button', { name: 'Delete file' }));
        expect(await screen.findByText('report.pdf deleted')).toBeDefined();
        expect(engine.spies.delete).toHaveBeenCalledWith(FILE_IDS.pdf, expect.anything());
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'File details' })).toBeNull();
        });
        await waitFor(() => {
            expect(screen.queryByRole('link', { name: 'report.pdf' })).toBeNull();
        });
    });

    it('reports a refusal and keeps the file', async () => {
        const { drawer, app, engine } = await openDrawer(FILE_IDS.pdf);
        engine.spies.delete.mockImplementation(() => problemResponse('validation-failed'));
        await app.user.click(within(drawer).getByRole('button', { name: 'Delete' }));
        const confirm = await screen.findByRole('dialog', { name: 'Delete file?' });
        await app.user.click(within(confirm).getByRole('button', { name: 'Delete file' }));
        expect(await screen.findByText('Could not delete report.pdf')).toBeDefined();
        expect(screen.getByRole('dialog', { name: 'File details' })).toBeDefined();
    });

    it('deletes from the row menu of the list', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/files', engineApi: engine.client });
        await screen.findByRole('link', { name: 'report.pdf' });
        await app.user.click(screen.getByRole('button', { name: 'Actions for report.pdf' }));
        await app.user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        const confirm = await screen.findByRole('dialog', { name: 'Delete file?' });
        await app.user.click(within(confirm).getByRole('button', { name: 'Delete file' }));
        expect(await screen.findByText('report.pdf deleted')).toBeDefined();
    });

    it('is absent without files.write, in the drawer and the list', async () => {
        const { drawer } = await openDrawer(FILE_IDS.pdf, { permissions: allBut('files.write') });
        expect(within(drawer).queryByRole('button', { name: 'Delete' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Actions for report.pdf' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Upload knowledge' })).toBeNull();
    });
});
