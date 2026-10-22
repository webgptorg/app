import { IntegrationId, PERMISSIONS } from '@ptbk/engine-api';
import type { ActivityItem, Permission, ReadIntegration } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { createIntegrationsEngine, HOSTILE_TEXT, INTEGRATION_IDS } from '../../testing/integrations-engine';
import type { IntegrationsEngine } from '../../testing/integrations-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
/** Route and dialog code are lazy chunks; on a loaded runner they take longer than the default second. */
const DIALOG_WAIT = { timeout: 10_000 };
// axe walks the whole page; on a loaded runner that alone can take longer than a render.
const AXE_TIMEOUT_MS = 60_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

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
        const settings = region('Settings');
        expect(within(settings).getByText('MCP server')).toBeDefined();
        const url = within(settings).getByRole('link', { name: /https:\/\/mcp\.example\.com\/sse/ });
        expect(url.getAttribute('href')).toBe('https://mcp.example.com/sse');
        expect(url.getAttribute('rel')).toBe('noopener noreferrer');

        expect(within(region('Scopes')).getByText('docs:read')).toBeDefined();
        expect(within(region('Scopes')).getByText('docs:search')).toBeDefined();
        const tools = region('Tools');
        expect(within(tools).getByText('fetch_page')).toBeDefined();
        expect(within(tools).getByText(HOSTILE_TEXT)).toBeDefined();
        expect(tools.querySelector('img, script')).toBeNull();

        const secrets = region('Secrets it uses');
        expect(within(secrets).getByRole('link', { name: 'DOCS_TOKEN' }).getAttribute('href')).toBe(
            '/secrets?q=DOCS_TOKEN',
        );
        expect(within(secrets).getByText('Available')).toBeDefined();
    });

    it('shows a repository on GitHub and a missing secret with a link to fix it', async () => {
        await renderDetail(INTEGRATION_IDS.billing);
        const repository = within(region('Settings')).getByRole('link', { name: /acme\/billing/ });
        expect(repository.getAttribute('href')).toBe('https://github.com/acme/billing');
        expect(screen.getByText('Secrets not available: GITHUB_TOKEN.')).toBeDefined();
        expect((await screen.findByRole('link', { name: 'Ada' })).getAttribute('href')).toBe('/agents/agent-ada');
        expect(within(region('Scopes')).getByText('contents:read')).toBeDefined();
        const secrets = region('Secrets it uses');
        expect(within(secrets).getByText('Missing')).toBeDefined();
        expect(within(secrets).getByRole('link', { name: 'GITHUB_TOKEN' }).getAttribute('href')).toBe(
            '/secrets?q=GITHUB_TOKEN',
        );
        expect(within(secrets).getByText(/on the Secrets page/)).toBeDefined();
    });

    it('names a missing secret without a link for a member who may not see secrets', async () => {
        await renderDetail(INTEGRATION_IDS.billing, createIntegrationsEngine({ permissions: allBut('secrets.read') }));
        const secrets = region('Secrets it uses');
        expect(within(secrets).getByText('GITHUB_TOKEN')).toBeDefined();
        expect(within(secrets).queryByRole('link')).toBeNull();
        expect(within(secrets).getByText('Missing')).toBeDefined();
        expect(within(secrets).getByText(/Ask someone who manages secrets/)).toBeDefined();
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
        expect(within(region('Scopes')).getByText('chat:write')).toBeDefined();
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
        expect(within(activity).getByText('Docs search: tool search used')).toBeDefined();
        expect(within(activity).getByText('Docs search connected')).toBeDefined();
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
        await user.click(screen.getByRole('button', { name: 'Disable' }));
        expect(await screen.findByText('Disabled')).toBeDefined();
        act(() => {
            refuse?.();
        });
        expect(await screen.findByText('Docs search could not be disabled.')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByText('Disabled')).toBeNull();
        });
        expect(screen.getByText('Connected')).toBeDefined();
    });

    it('enables a disabled integration and rolls back on error', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.enable.mockImplementationOnce(() => problemResponse('unavailable'));
        const { user } = await renderDetail(INTEGRATION_IDS.off, engine);
        await user.click(screen.getByRole('button', { name: 'Enable' }));
        expect(await screen.findByText('Review bot could not be enabled.')).toBeDefined();
        expect(await screen.findByText('Disabled')).toBeDefined();

        await user.click(screen.getByRole('button', { name: 'Enable' }));
        expect(await screen.findByRole('button', { name: 'Disable' })).toBeDefined();
        expect(engine.spies.enable).toHaveBeenCalledTimes(2);
    });

    it('checks the connection, waits for the engine and shows the status it returns', async () => {
        const engine = createIntegrationsEngine();
        const { user } = await renderDetail(INTEGRATION_IDS.billing, engine);
        await user.click(screen.getByRole('button', { name: 'Check connection' }));
        expect(await screen.findByText('Billing repository: Needs attention')).toBeDefined();
        expect(engine.spies.check).toHaveBeenCalledWith(INTEGRATION_IDS.billing, expect.anything());
    });

    it('deletes only after confirmation', async () => {
        const engine = createIntegrationsEngine();
        const { user, router } = await renderDetail(INTEGRATION_IDS.docs, engine);
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        const dialog = await screen.findByRole('dialog', { name: 'Delete Docs search?' }, DIALOG_WAIT);
        expect(engine.spies.delete).not.toHaveBeenCalled();
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(engine.spies.delete).not.toHaveBeenCalled();

        await user.click(screen.getByRole('button', { name: 'Delete' }));
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
        expect(await screen.findByText('Docs search deleted')).toBeDefined();
    });
});
