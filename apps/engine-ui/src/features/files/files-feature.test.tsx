import { FileId, KNOWN_CAPABILITIES, PERMISSIONS } from '@ptbk/engine-api';
import type { Activity, AgentId, Permission } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FEATURES } from '../../app/features';
import { defineFeature } from '../../app/registry/feature';
import { visibleFeatures } from '../../app/registry/visibility';
import { expectNoAxeViolations } from '../../testing/axe';
import { createFilesEngine, FILE_IDS, HOSTILE_FILE_NAME } from '../../testing/files-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { TEST_NOW } from '../../testing/test-engine-api';
import { filesFeature } from './files-feature';
import { AgentFilesSearch, fileListParams, FilesSearch } from './files-search';

const TIMEOUT_MS = 30_000;
/** The card's code is lazy and waits for two queries, slower than the default wait on a busy runner. */
const CARD_LOAD_MS = 10_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));
const ALL_CAPABILITIES = Object.values(KNOWN_CAPABILITIES);
const WITHOUT_FILES = ALL_CAPABILITIES.filter(({ id }) => id !== 'files');
const access = (permissions: readonly Permission[], capabilities = ALL_CAPABILITIES) => ({
    can: (permission: Permission) => permissions.includes(permission),
    supports: (capability: { readonly id: string; readonly version: number }) =>
        capabilities.some(({ id, version }) => id === capability.id && version === capability.version),
});

describe('registry gating', () => {
    it('registers nav, tab, card, renderers, attention, sync and commands only with files@1 and files.read', () => {
        const full = visibleFeatures(FEATURES, access(PERMISSIONS)).find(({ id }) => id === 'files');
        expect(full?.nav).toMatchObject({ group: 'resources', to: '/files' });
        expect(full?.agentTabs?.map(({ id, to }) => [id, to])).toEqual([['files', '/agents/$agentId/files']]);
        expect(full?.agentOverviewCards?.map(({ id }) => id)).toEqual(['files.knowledge']);
        expect(full?.activityRenderers?.map(({ kind, versions }) => [kind, versions])).toEqual([['file.*', [1]]]);
        expect(full?.commands?.map(({ id }) => id)).toEqual(['files.open', 'files.upload-knowledge']);
        expect(full?.attention?.id).toBe('files.scan-problems');
        expect(full?.eventSync).toBeDefined();
        expect(visibleFeatures(FEATURES, access(allBut('files.read'))).some(({ id }) => id === 'files')).toBe(false);
        expect(visibleFeatures(FEATURES, access(PERMISSIONS, WITHOUT_FILES)).some(({ id }) => id === 'files')).toBe(
            false,
        );
    });

    it('offers "Upload knowledge" only with files.write', () => {
        const readOnly = visibleFeatures(FEATURES, access(allBut('files.write'))).find(({ id }) => id === 'files');
        expect(readOnly?.commands?.map(({ id }) => id)).toEqual(['files.open']);
    });
});

describe('without files@1 or files.read', { timeout: TIMEOUT_MS }, () => {
    it('shows no nav item, agent tab or overview card, and /files is not available on this engine', async () => {
        const engine = createFilesEngine({ capabilities: WITHOUT_FILES });
        renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client });
        await screen.findAllByRole('region', { name: 'Details' });
        expect(screen.queryByRole('link', { name: 'Files' })).toBeNull();
        expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull();
        expect(screen.queryByRole('region', { name: 'Knowledge at a glance' })).toBeNull();
        expect(engine.spies.stats).not.toHaveBeenCalled();
        renderWithProviders({ path: '/files', engineApi: engine.client });
        expect(await screen.findByText(/not available on this engine/i)).toBeDefined();
        expect(engine.spies.list).not.toHaveBeenCalled();
    });

    it('says "no access" without files.read', async () => {
        const engine = createFilesEngine({ permissions: allBut('files.read') });
        renderWithProviders({ path: '/files', engineApi: engine.client });
        expect(await screen.findByText(/no access/i)).toBeDefined();
        expect(engine.spies.list).not.toHaveBeenCalled();
    });

    it('explains an agent Files tab the engine does not offer', async () => {
        const engine = createFilesEngine({ capabilities: WITHOUT_FILES });
        renderWithProviders({ path: '/agents/agent-ada/files', engineApi: engine.client });
        expect(await screen.findByText(/not available on this engine/i)).toBeDefined();
    });
});

describe('agent Files tab', { timeout: TIMEOUT_MS }, () => {
    it('shows knowledge first, then outputs and other files, each from the engine', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/agents/agent-ada/files', engineApi: engine.client });
        expect(await screen.findByRole('link', { name: 'page.html' })).toBeDefined();
        expect(screen.getByRole('tab', { name: 'Knowledge' }).getAttribute('aria-selected')).toBe('true');
        expect(engine.spies.list.mock.calls.at(-1)?.[0]).toMatchObject({ agentId: 'agent-ada', purpose: 'knowledge' });
        expect(screen.queryByRole('link', { name: 'photo.png' })).toBeNull();
        await app.user.click(screen.getByRole('tab', { name: 'Outputs and other files' }));
        expect(await screen.findByRole('link', { name: 'photo.png' })).toBeDefined();
        expect(engine.spies.list.mock.calls.at(-1)?.[0]).toMatchObject({
            agentId: 'agent-ada',
            purpose: 'output,attachment,upload',
        });
        expect(app.router.state.location.search).toMatchObject({ section: 'other' });
        expect(screen.getByRole('link', { name: HOSTILE_FILE_NAME })).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Choose files' })).toBeNull();
    });

    it('filters by scan and search, opens the drawer from its URL and passes axe', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({
            path: `/agents/agent-ada/files?section=other&scan=infected&file=${FILE_IDS.infected}`,
            engineApi: engine.client,
        });
        const drawer = await screen.findByRole('dialog', { name: 'File details' });
        expect(await within(drawer).findByText('SHA-256')).toBeDefined();
        expect(engine.spies.list.mock.calls.at(-1)?.[0]).toMatchObject({ scan: 'infected' });
        await app.user.keyboard('{Escape}');
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'File details' })).toBeNull();
        });
        await app.user.type(screen.getByLabelText('Search files'), 'invoice');
        await waitFor(() => {
            expect(engine.spies.list.mock.calls.at(-1)?.[0]).toMatchObject({ q: 'invoice', scan: 'infected' });
        });
        expect(await screen.findByRole('link', { name: 'invoice.png' })).toBeDefined();
        await expectNoAxeViolations(document.body);
    });

    it('says when an agent has no files, and when nothing matches', async () => {
        const engine = createFilesEngine();
        const app = renderWithProviders({ path: '/agents/agent-grace/files?section=other', engineApi: engine.client });
        expect(await screen.findByText('No other files')).toBeDefined();
        await app.user.click(screen.getByRole('tab', { name: 'Knowledge' }));
        await screen.findByRole('link', { name: 'Note 001.md' });
        await app.user.type(screen.getByLabelText('Search files'), 'zzz');
        expect(await screen.findByText('No files match your filters', {}, { timeout: 5_000 })).toBeDefined();
        await app.user.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(await screen.findByRole('link', { name: 'Note 001.md' })).toBeDefined();
    });
});

describe('knowledge at a glance', { timeout: TIMEOUT_MS }, () => {
    it('counts files by purpose, links scan problems and lists the latest outputs', async () => {
        const engine = createFilesEngine();
        renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client });
        const card = await screen.findByRole('region', { name: 'Knowledge at a glance' }, { timeout: CARD_LOAD_MS });
        const outputs = await within(card).findByRole('link', { name: HOSTILE_FILE_NAME });
        expect(outputs.getAttribute('href')).toBe(`/agents/agent-ada/files?file=${FILE_IDS.hostile}`);
        expect(within(card).getByText('Knowledge').nextElementSibling?.textContent).toBe('2');
        expect(within(card).getByText('Output').nextElementSibling?.textContent).toBe('4');
        const problems = within(card).getByRole('link', { name: /1 file needs attention/ });
        expect(problems.getAttribute('href')).toBe('/files?agentId=agent-ada&scan=infected%2Cfailed');
        expect(engine.spies.stats).toHaveBeenCalledWith({ agentId: 'agent-ada' }, expect.anything());
    });

    it('leaves out the outputs list and the zero counts when an agent has produced nothing', async () => {
        const engine = createFilesEngine();
        renderWithProviders({ path: '/agents/agent-grace', engineApi: engine.client });
        const card = await screen.findByRole('region', { name: 'Knowledge at a glance' }, { timeout: CARD_LOAD_MS });
        expect(await within(card).findByText(/1 file needs attention/)).toBeDefined();
        expect(within(card).queryByText('Latest outputs')).toBeNull();
        expect(within(card).queryByText('Output')).toBeNull();
    });
});

describe('attention', { timeout: TIMEOUT_MS }, () => {
    it('counts infected and failed scans and links to exactly those', async () => {
        const engine = createFilesEngine();
        const seen: { count: number; to: string; search?: Readonly<Record<string, string>> }[] = [];
        const probe = defineFeature({
            id: 'probe',
            requires: {},
            agentOverviewCards: [
                {
                    id: 'probe',
                    order: 0,
                    component: () => {
                        const attention = filesFeature.attention.useAttention();
                        seen.push(attention);
                        return <p>{`attention ${String(attention.count)}`}</p>;
                    },
                },
            ],
        });
        renderWithProviders({ path: '/agents/agent-ada', engineApi: engine.client, features: [...FEATURES, probe] });
        expect(await screen.findByText('attention 2')).toBeDefined();
        expect(seen.at(-1)).toEqual({ count: 2, to: '/files', search: { scan: 'infected,failed' } });
    });
});

describe('live updates', { timeout: TIMEOUT_MS }, () => {
    it('shows a file the engine adds, from its file.changed event, without a manual refetch', async () => {
        const engine = createFilesEngine();
        renderWithProviders({ path: '/files', engineApi: engine.client });
        await screen.findByRole('link', { name: 'photo.png' });
        await act(async () => {
            await engine.controller.addFile({
                name: 'summary.md',
                contentType: 'text/markdown',
                content: new Blob(['# Summary']),
                purpose: 'output',
                agentId: 'agent-ada',
                createdBy: 'member-owner',
            });
        });
        expect(await screen.findByRole('link', { name: 'summary.md' })).toBeDefined();
    });

    it('updates an open file when its scan result arrives', async () => {
        const engine = createFilesEngine();
        renderWithProviders({ path: `/files?file=${FILE_IDS.pending}`, engineApi: engine.client });
        const drawer = await screen.findByRole('dialog', { name: 'File details' });
        expect(await within(drawer).findByText('Scanning')).toBeDefined();
        act(() => {
            engine.controller.setFileScan(FILE_IDS.pending, 'failed');
        });
        expect(await within(drawer).findByText('Scan failed')).toBeDefined();
    });
});

describe('file activity renderers', { timeout: TIMEOUT_MS }, () => {
    const base = {
        v: 1,
        at: TEST_NOW.toISOString(),
        agentId: 'agent-ada' as AgentId,
        actor: { kind: 'system' },
        fileId: FileId.parse(FILE_IDS.photo),
        name: HOSTILE_FILE_NAME,
    } as const;
    const ACTIVITIES = [
        { ...base, id: 'a1', kind: 'file.created', purpose: 'output' },
        { ...base, id: 'a2', kind: 'file.deleted' },
        { ...base, id: 'a3', kind: 'file.scan-failed' },
    ] as unknown as readonly Activity[];

    it('renders every v1 file kind, the name as text, with a link to the file', async () => {
        const [renderer] = filesFeature.activityRenderers;
        const feed = defineFeature({
            id: 'feed',
            requires: {},
            agentOverviewCards: [
                {
                    id: 'feed',
                    order: 0,
                    component: () => (
                        <ul aria-label="Feed">
                            {ACTIVITIES.map((activity) => (
                                <li key={activity.id}>
                                    <renderer.component activity={activity} />
                                </li>
                            ))}
                        </ul>
                    ),
                },
            ],
        });
        const { container } = renderWithProviders({
            path: '/agents/agent-ada',
            engineApi: createFilesEngine().client,
            features: [...FEATURES, feed],
        });
        const list = await screen.findByRole('list', { name: 'Feed' });
        expect(within(list).getByText(`${HOSTILE_FILE_NAME} added (Output)`)).toBeDefined();
        expect(within(list).getByText(`${HOSTILE_FILE_NAME} deleted`)).toBeDefined();
        expect(within(list).getByText(`The virus scan of ${HOSTILE_FILE_NAME} failed`)).toBeDefined();
        const links = within(list).getAllByRole('link', { name: 'Open file' });
        expect(links).toHaveLength(2);
        for (const link of links) expect(link.getAttribute('href')).toBe(`/files?file=${FILE_IDS.photo}`);
        expect(container.querySelector('img[src="x"]')).toBeNull();
        expect(ACTIVITIES.map((activity) => renderer.summary(activity))).toEqual([
            `${HOSTILE_FILE_NAME} added (Output)`,
            `${HOSTILE_FILE_NAME} deleted`,
            `The virus scan of ${HOSTILE_FILE_NAME} failed`,
        ]);
    });

    it('refreshes the list on file activity from the event stream', async () => {
        const engine = createFilesEngine();
        renderWithProviders({ path: '/files', engineApi: engine.client });
        await screen.findByRole('link', { name: 'photo.png' });
        const calls = engine.spies.list.mock.calls.length;
        act(() => {
            engine.controller.appendActivity({
                kind: 'file.deleted',
                agentId: 'agent-ada',
                actor: { kind: 'system' },
                fileId: FILE_IDS.photo,
                name: 'photo.png',
            });
        });
        await waitFor(() => {
            expect(engine.spies.list.mock.calls.length).toBeGreaterThan(calls);
        });
    });
});

describe('search params', () => {
    it('drop what they do not know and keep valid scan sets', () => {
        expect(FilesSearch.parse({ scan: 'infected,failed', purpose: 'output', file: 42 })).toMatchObject({
            scan: 'infected,failed',
            purpose: 'output',
            file: '42',
            sort: '-createdAt',
        });
        expect(FilesSearch.parse({ scan: 'infected,bogus', purpose: 'secret', sort: 'size', cursor: '==' })).toEqual({
            sort: '-createdAt',
        });
        expect(AgentFilesSearch.parse({ section: 'everything' })).toMatchObject({ section: 'knowledge' });
    });

    it('send every filter to the engine and nothing else', () => {
        expect(
            fileListParams(FilesSearch.parse({ q: 'a', scan: 'clean', agentId: 'agent-ada', file: 'f', upload: true })),
        ).toEqual({ limit: 50, sort: '-createdAt', q: 'a', scan: 'clean', agentId: 'agent-ada' });
    });
});
