import { IntegrationId } from '@ptbk/engine-api';
import type { ActivityItem, ReadIntegration } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { createIntegrationsEngine, HOSTILE_TEXT, INTEGRATION_IDS } from '../../testing/integrations-engine';
import type { IntegrationsEngine } from '../../testing/integrations-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';
import { checkOutcome } from './use-integration-mutations';

const TIMEOUT_MS = 20_000;
/** Route and dialog code are lazy chunks; on a loaded runner they take longer than the default second. */
const DIALOG_WAIT = { timeout: 10_000 };
// axe walks the whole page; on a loaded runner that alone can take longer than a render.
const AXE_TIMEOUT_MS = 60_000;

async function renderDetail(integrationId: string, engine: IntegrationsEngine = createIntegrationsEngine()) {
    const app = renderWithProviders({ path: `/integrations/${integrationId}`, engineApi: engine.client });
    await screen.findByRole('region', { name: 'Settings' }, DIALOG_WAIT);
    return { ...app, engine };
}

const region = (name: string) => screen.getByRole('region', { name });

/** An integration as the client reads it, for shapes the in-memory engine cannot hold (unknown kinds, bad URLs). */
function readIntegration(fields: Partial<ReadIntegration> & Pick<ReadIntegration, 'kind'>): ReadIntegration {
    return {
        id: IntegrationId.parse('int-odd'),
        agentId: null,
        name: 'Odd one',
        status: 'connected',
        statusDetail: null,
        scopes: [],
        secretRefs: [],
        tools: [],
        lastActivityAt: null,
        createdBy: 'member-owner',
        createdAt: TEST_NOW.toISOString(),
        updatedAt: TEST_NOW.toISOString(),
        ...fields,
    } as ReadIntegration;
}

describe('integration detail', { timeout: TIMEOUT_MS }, () => {
    it('shows an MCP server’s URL as a safe link, its scopes, tools as text and its secrets by name', async () => {
        await renderDetail(INTEGRATION_IDS.docs);
        expect(screen.getByRole('heading', { level: 1, name: 'Docs search' })).toBeDefined();
        const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
        expect(within(trail).getByRole('link', { name: 'Integrations' }).getAttribute('href')).toBe('/integrations');
        await waitFor(() => {
            expect(document.title).toBe('Docs search · Integrations · Test engine');
        });
        const settings = region('Settings');
        expect(within(settings).getByText('MCP server')).toBeDefined();
        const url = within(settings).getByRole('link', { name: /https:\/\/mcp\.example\.com\/sse/ });
        expect(url.getAttribute('href')).toBe('https://mcp.example.com/sse');
        expect(url.getAttribute('rel')).toBe('noopener noreferrer');

        expect(within(settings).getByText('docs:read')).toBeDefined();
        expect(within(settings).getByText('docs:search')).toBeDefined();
        const tools = region('Tools');
        expect(within(tools).getByText('fetch_page')).toBeDefined();
        expect(within(tools).getByText(HOSTILE_TEXT)).toBeDefined();
        expect(tools.querySelector('img, script')).toBeNull();

        const secrets = region('Secrets it uses');
        expect(within(secrets).getByText('DOCS_TOKEN')).toBeDefined();
        expect(within(secrets).queryByRole('link')).toBeNull();
        expect(within(secrets).getByText('Available')).toBeDefined();
    });

    it('shows a repository on GitHub and a missing secret, set on the engine', async () => {
        await renderDetail(INTEGRATION_IDS.billing);
        const repository = within(region('Settings')).getByRole('link', { name: /acme\/billing/ });
        expect(repository.getAttribute('href')).toBe('https://github.com/acme/billing');
        expect(screen.getByText('Secrets not available: GITHUB_TOKEN.')).toBeDefined();
        expect((await screen.findByRole('link', { name: 'Ada' })).getAttribute('href')).toBe('/agents/agent-ada');
        expect(within(region('Settings')).getByText('contents:read')).toBeDefined();
        const secrets = region('Secrets it uses');
        expect(within(secrets).getByText('Missing')).toBeDefined();
        expect(within(secrets).getByText('GITHUB_TOKEN')).toBeDefined();
        expect(within(secrets).queryByRole('link')).toBeNull();
        expect(within(secrets).getByText(/set in the project, not here/)).toBeDefined();
        const banner = screen
            .getByText('Secrets not available: GITHUB_TOKEN.')
            .closest('[role="alert"]') as HTMLElement;
        expect(within(banner).queryByRole('link')).toBeNull();
    });

    it('shows a calendar’s provider and account and its error detail as text', async () => {
        await renderDetail(INTEGRATION_IDS.calendar);
        const settings = region('Settings');
        expect(within(settings).getByText('google')).toBeDefined();
        expect(within(settings).getByText('ada@example.com')).toBeDefined();
        expect(screen.getByText(`The provider refused the token: ${HOSTILE_TEXT}`)).toBeDefined();
        expect(within(region('Secrets it uses')).getByText('Revoked')).toBeDefined();
        expect(document.querySelector('main img, main script')).toBeNull();
    });

    it('renders an unknown kind as a generic card with its raw kind', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.get.mockResolvedValue({
            kind: 'ok',
            data: readIntegration({ kind: 'unknown', rawKind: 'slack-workspace', scopes: ['chat:write'] }),
        });
        await renderDetail('int-odd', engine);
        const settings = region('Settings');
        expect(within(settings).getAllByText('slack-workspace').length).toBeGreaterThan(0);
        expect(within(settings).getByText(/does not know this kind/)).toBeDefined();
        expect(within(settings).getByText('chat:write')).toBeDefined();
    });

    it('leaves out what an integration does not have: no scopes row, no secrets, one quiet line for tools', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.get.mockResolvedValue({
            kind: 'ok',
            data: readIntegration({ kind: 'mcp-server', config: { url: 'https://a.example/' } } as never),
        });
        await renderDetail('int-odd', engine);
        expect(within(region('Settings')).queryByText('Scopes')).toBeNull();
        expect(screen.queryByRole('region', { name: 'Secrets it uses' })).toBeNull();
        const tools = region('Tools');
        expect(within(tools).getByText('This integration offers no tools.')).toBeDefined();
        expect(within(tools).queryByRole('list')).toBeNull();
    });

    it('renders a javascript: MCP URL as text without an href', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.get.mockResolvedValue({
            kind: 'ok',
            data: readIntegration({ kind: 'mcp-server', config: { url: 'javascript:alert(1)' } } as never),
        });
        await renderDetail('int-odd', engine);
        const settings = region('Settings');
        expect(within(settings).getByText('javascript:alert(1)')).toBeDefined();
        expect(within(settings).queryByRole('link')).toBeNull();
        expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    });

    it('shows each status as text, an unknown one as "Unknown"', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.get.mockResolvedValue({
            kind: 'ok',
            data: readIntegration({ kind: 'mcp-server', status: 'unknown', config: { url: 'https://a.example/' } }),
        });
        await renderDetail('int-odd', engine);
        expect(screen.getByText('Unknown')).toBeDefined();
    });

    it('renders known activity through the registered renderer and an unknown kind through the fallback', async () => {
        const engine = createIntegrationsEngine();
        const real = await engine.client.activity.list(
            { integrationId: IntegrationId.parse(INTEGRATION_IDS.docs) },
            AbortSignal.timeout(1_000),
        );
        if (real.kind !== 'ok') throw new Error('expected activity');
        const unknown: ActivityItem = {
            kind: 'unknown',
            base: { kind: 'integration.rotated', v: 1, id: 'act-x', at: TEST_NOW.toISOString(), agentId: null },
            raw: {},
        } as unknown as ActivityItem;
        engine.spies.activity.mockResolvedValue({
            kind: 'ok',
            data: { ...real.data, items: [unknown, ...real.data.items] },
        });
        await renderDetail(INTEGRATION_IDS.docs, engine);
        const activity = await screen.findByRole('list', { name: 'Recent activity' });
        // On its own page the integration is named, not linked; the tool and the outcome say what happened.
        expect(within(activity).getByText('search')).toBeDefined();
        expect(within(activity).getByText('Tool used')).toBeDefined();
        expect(within(activity).getAllByText('Connected').length).toBeGreaterThan(0);
        expect(within(activity).queryByRole('link', { name: 'Docs search' })).toBeNull();
        expect(within(activity).getByText('Activity: integration.rotated')).toBeDefined();
        expect(engine.spies.activity).toHaveBeenCalledWith(
            { integrationId: INTEGRATION_IDS.docs, limit: 20 },
            expect.anything(),
        );
    });

    it('says when the integration does not exist, and shows an error with retry', async () => {
        renderWithProviders({ path: '/integrations/int-nope', engineApi: createIntegrationsEngine().client });
        expect(await screen.findByRole('heading', { level: 1, name: 'Integration not found' })).toBeDefined();

        const engine = createIntegrationsEngine();
        engine.spies.get.mockImplementation(() => problemResponse('validation-failed'));
        const { user } = renderWithProviders({ path: '/integrations/int-docs', engineApi: engine.client });
        expect(await screen.findByText('This integration could not be loaded.')).toBeDefined();
        engine.spies.get.mockRestore();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Docs search' })).toBeDefined();
    });

    it('follows integration.changed events without polling', async () => {
        const { engine } = await renderDetail(INTEGRATION_IDS.docs);
        const calls = engine.spies.get.mock.calls.length;
        act(() => {
            engine.controller.setIntegrationStatus(INTEGRATION_IDS.docs, {
                status: 'error',
                statusDetail: 'The server went away.',
            });
        });
        expect(await screen.findByText('The server went away.')).toBeDefined();
        expect(engine.spies.get.mock.calls.length).toBeGreaterThan(calls);
    });

    it('has no axe violations', { timeout: AXE_TIMEOUT_MS }, async () => {
        const { container } = await renderDetail(INTEGRATION_IDS.billing);
        await screen.findByRole('list', { name: 'Recent activity' }).catch(() => undefined);
        await expectNoAxeViolations(container);
    });
});

describe('integration actions', { timeout: TIMEOUT_MS }, () => {
    it('disables at once and rolls back with a failure toast when the engine refuses', async () => {
        const engine = createIntegrationsEngine();
        let refuse: (() => void) | undefined;
        engine.spies.disable.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    refuse = () => {
                        resolve(problemResponse('unavailable'));
                    };
                }),
        );
        const { user } = await renderDetail(INTEGRATION_IDS.docs, engine);
        // The status, and the activity lines that say "Connected" as their outcome.
        await screen.findAllByText('Connected');
        const connected = screen.getAllByText('Connected').length;
        await user.click(screen.getByRole('button', { name: 'More actions' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Disable' }));
        expect(await screen.findByText('Disabled')).toBeDefined();
        act(() => {
            refuse?.();
        });
        expect(await screen.findByText('Docs search could not be disabled.')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByText('Disabled')).toBeNull();
        });
        expect(screen.getAllByText('Connected')).toHaveLength(connected);
    });

    it('enables a disabled integration and rolls back on error', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.enable.mockImplementationOnce(() => problemResponse('unavailable'));
        const { user } = await renderDetail(INTEGRATION_IDS.off, engine);
        await user.click(screen.getByRole('button', { name: 'Enable' }));
        expect(await screen.findByText('Review bot could not be enabled.')).toBeDefined();
        expect(await screen.findByText('Disabled')).toBeDefined();

        await user.click(screen.getByRole('button', { name: 'Enable' }));
        expect(await screen.findByRole('button', { name: 'Check connection' })).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
        expect(engine.spies.enable).toHaveBeenCalledTimes(2);
    });

    it('checks the connection and reports a remaining problem as a warning naming the missing secret', async () => {
        const engine = createIntegrationsEngine();
        const { user } = await renderDetail(INTEGRATION_IDS.billing, engine);
        await user.click(screen.getByRole('button', { name: 'Check connection' }));
        expect(
            await screen.findByText('Billing repository still needs attention. Missing: GITHUB_TOKEN.'),
        ).toBeDefined();
        expect(engine.spies.check).toHaveBeenCalledWith(INTEGRATION_IDS.billing, expect.anything());
    });

    it('reports a working connection as a success', async () => {
        const { user } = await renderDetail(INTEGRATION_IDS.docs);
        await user.click(screen.getByRole('button', { name: 'Check connection' }));
        expect(await screen.findByText('Docs search connected.')).toBeDefined();
    });

    it('gives each checked status the tone of its outcome: only a working connection is a success', () => {
        const missing = { name: 'TOKEN', secretId: null, state: 'missing' } as const;
        const tone = (fields: Partial<ReadIntegration>) =>
            checkOutcome(readIntegration({ kind: 'mcp-server', ...fields } as ReadIntegration));
        expect(tone({ status: 'connected' })).toEqual({ tone: 'success', title: 'Odd one connected.' });
        expect(tone({ status: 'needs-attention' })).toEqual({
            tone: 'warning',
            title: 'Odd one still needs attention.',
        });
        expect(tone({ status: 'needs-attention', secretRefs: [missing] }).title).toBe(
            'Odd one still needs attention. Missing: TOKEN.',
        );
        expect(tone({ status: 'error' }).tone).toBe('danger');
        expect(tone({ status: 'disconnected' }).tone).toBe('info');
        expect(tone({ status: 'unknown' }).tone).toBe('info');
    });

    it('links back to the list, and not to itself from its own activity', async () => {
        await renderDetail(INTEGRATION_IDS.docs);
        const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
        expect(within(trail).getByRole('link', { name: 'Integrations' }).getAttribute('href')).toBe('/integrations');
        await screen.findByRole('list', { name: 'Recent activity' });
        expect(screen.queryByRole('link', { name: 'Open integration' })).toBeNull();
        const url = within(region('Settings')).getByRole('link', { name: /mcp\.example\.com/ });
        expect(url.textContent).not.toContain('(mcp.example.com)');
    });

    it('deletes only after confirmation', async () => {
        const engine = createIntegrationsEngine();
        const { user, router } = await renderDetail(INTEGRATION_IDS.docs, engine);
        await user.click(screen.getByRole('button', { name: 'More actions' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        const dialog = await screen.findByRole('dialog', { name: 'Delete Docs search?' }, DIALOG_WAIT);
        expect(engine.spies.delete).not.toHaveBeenCalled();
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(engine.spies.delete).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'More actions' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
        await user.click(
            within(await screen.findByRole('dialog', { name: 'Delete Docs search?' }, DIALOG_WAIT)).getByRole(
                'button',
                {
                    name: 'Delete',
                },
            ),
        );
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/integrations');
        });
        expect(engine.spies.delete).toHaveBeenCalledTimes(1);
        expect(await screen.findByText('Docs search deleted.')).toBeDefined();
    });
});
