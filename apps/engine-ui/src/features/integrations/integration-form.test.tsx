import { PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createIntegrationsEngine, INTEGRATION_IDS } from '../../testing/integrations-engine';
import type { IntegrationsEngine } from '../../testing/integrations-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { parseSecretNames, toFormErrors } from './integration-form';

const TIMEOUT_MS = 20_000;
/** Route and dialog code are lazy chunks; on a loaded runner they take longer than the default second. */
const DIALOG_WAIT = { timeout: 10_000 };
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

async function openAdd(
    name: 'Add MCP server' | 'Add repository',
    path = '/integrations',
    engine = createIntegrationsEngine(),
) {
    const app = renderWithProviders({ path, engineApi: engine.client });
    await app.user.click(await screen.findByRole('button', { name }, DIALOG_WAIT));
    return { ...app, engine, dialog: await screen.findByRole('dialog', { name }, DIALOG_WAIT) };
}

const noPasswordInputs = () => {
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
};

describe('secret names', () => {
    it('reads names separated by commas or lines, without blanks or repeats', () => {
        expect(parseSecretNames(' DOCS_TOKEN, ,GITHUB_TOKEN\nDOCS_TOKEN\n')).toEqual(['DOCS_TOKEN', 'GITHUB_TOKEN']);
        expect(parseSecretNames('')).toEqual([]);
    });

    it('maps the engine’s request paths onto the form’s fields', () => {
        expect(
            toFormErrors([
                { path: 'body.url', message: 'u' },
                { path: 'body.secretNames.2', message: 's' },
                { path: '/body/name', message: 'n' },
            ]),
        ).toEqual([
            { path: 'url', message: 'u' },
            { path: 'secretNames', message: 's' },
            { path: 'name', message: 'n' },
        ]);
    });
});

describe('add and edit integrations', { timeout: TIMEOUT_MS }, () => {
    it('adds an MCP server for one agent with secrets picked by name, and no value field anywhere', async () => {
        const { user, dialog, engine } = await openAdd('Add MCP server');
        noPasswordInputs();
        await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Search');
        await user.type(within(dialog).getByRole('textbox', { name: /^Server URL/ }), 'https://search.example.com/mcp');
        await user.selectOptions(await within(dialog).findByRole('combobox', { name: 'Used by' }), 'agent-ada');
        await user.click(await within(dialog).findByRole('checkbox', { name: 'DOCS_TOKEN' }));
        expect(within(dialog).getByRole('checkbox', { name: 'OLD_CALENDAR_TOKEN (revoked)' })).toBeDefined();
        await user.click(within(dialog).getByRole('button', { name: 'Add' }));
        await waitFor(() => {
            expect(screen.queryByRole('dialog')).toBeNull();
        });
        expect(engine.spies.create).toHaveBeenCalledWith(
            {
                kind: 'mcp-server',
                name: 'Search',
                agentId: 'agent-ada',
                url: 'https://search.example.com/mcp',
                secretNames: ['DOCS_TOKEN'],
            },
            expect.anything(),
        );
        expect(await screen.findByText('Search added')).toBeDefined();
    });

    it('refuses a URL that is not https and a repository that is not owner/name before sending', async () => {
        const { user, dialog, engine } = await openAdd('Add MCP server');
        await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Plain');
        await user.type(within(dialog).getByRole('textbox', { name: /^Server URL/ }), 'javascript:alert(1)');
        await user.click(within(dialog).getByRole('button', { name: 'Add' }));
        expect(await within(dialog).findByText('Enter an address that starts with https.')).toBeDefined();
        expect(engine.spies.create).not.toHaveBeenCalled();
    });

    it('adds a GitHub repository engine-wide, with names typed by a member who may not read secrets', async () => {
        const engine = createIntegrationsEngine({ permissions: allBut('secrets.read', 'secrets.manage') });
        const { user, dialog } = await openAdd('Add repository', '/integrations', engine);
        noPasswordInputs();
        expect(within(dialog).queryByRole('checkbox')).toBeNull();
        await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Website');
        await user.type(within(dialog).getByRole('textbox', { name: /^GitHub repository/ }), 'acme/website');
        await user.type(within(dialog).getByRole('textbox', { name: /^Secrets it uses/ }), 'GITHUB_TOKEN, DEPLOY_KEY');
        await user.click(within(dialog).getByRole('button', { name: 'Add' }));
        await waitFor(() => {
            expect(engine.spies.create).toHaveBeenCalledWith(
                {
                    kind: 'repository',
                    name: 'Website',
                    agentId: null,
                    provider: 'github',
                    repository: 'acme/website',
                    secretNames: ['GITHUB_TOKEN', 'DEPLOY_KEY'],
                },
                expect.anything(),
            );
        });
    });

    it('starts on an agent’s tab with that agent chosen', async () => {
        const { dialog } = await openAdd('Add MCP server', '/agents/agent-grace/integrations');
        await waitFor(() => {
            expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Used by' }).value).toBe(
                'agent-grace',
            );
        });
    });

    it('puts a taken name and the engine’s field errors on their fields', async () => {
        const { user, dialog } = await openAdd('Add MCP server');
        await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Docs search');
        await user.type(within(dialog).getByRole('textbox', { name: /^Server URL/ }), 'https://docs.example.com/mcp');
        await user.click(within(dialog).getByRole('button', { name: 'Add' }));
        expect(await within(dialog).findByText('This name is already taken.')).toBeDefined();
        expect(await screen.findByText('An integration named Docs search already exists.')).toBeDefined();
    });

    it('maps a validation error on the URL to the URL field', async () => {
        const engine = createIntegrationsEngine();
        engine.spies.update.mockResolvedValueOnce({
            kind: 'problem',
            problem: {
                type: 'about:blank',
                title: 'Invalid',
                status: 422,
                code: 'validation-failed',
                errors: [{ path: 'body.url', message: 'The engine cannot reach this server.' }],
            },
        });
        const app = renderWithProviders({ path: `/integrations/${INTEGRATION_IDS.docs}`, engineApi: engine.client });
        await app.user.click(await screen.findByRole('button', { name: 'Edit' }));
        const dialog = await screen.findByRole('dialog', { name: 'Edit Docs search' }, DIALOG_WAIT);
        const url = within(dialog).getByRole('textbox', { name: /^Server URL/ });
        await app.user.clear(url);
        await app.user.type(url, 'https://docs.example.org/mcp');
        await app.user.click(within(dialog).getByRole('button', { name: 'Save' }));
        expect(await within(dialog).findByText('The engine cannot reach this server.')).toBeDefined();
    });

    it('edits the name, URL and secret references, keeping references it has', async () => {
        const engine = createIntegrationsEngine();
        const app = renderWithProviders({ path: `/integrations/${INTEGRATION_IDS.docs}`, engineApi: engine.client });
        await app.user.click(await screen.findByRole('button', { name: 'Edit' }));
        const dialog = await screen.findByRole('dialog', { name: 'Edit Docs search' }, DIALOG_WAIT);
        noPasswordInputs();
        expect(within(dialog).queryByRole('combobox', { name: 'Used by' })).toBeNull();
        expect(await within(dialog).findByRole('checkbox', { name: 'DOCS_TOKEN' })).toHaveProperty('checked', true);
        const name = within(dialog).getByRole('textbox', { name: /^Name/ });
        await app.user.clear(name);
        await app.user.type(name, 'Docs');
        await app.user.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(engine.spies.update).toHaveBeenCalledWith(
                INTEGRATION_IDS.docs,
                { name: 'Docs', secretNames: ['DOCS_TOKEN'] },
                expect.anything(),
            );
        });
        expect(await screen.findByRole('heading', { level: 1, name: 'Docs' })).toBeDefined();
    });

    it('keeps a missing reference listed and ticked when editing', async () => {
        const app = renderWithProviders({
            path: `/integrations/${INTEGRATION_IDS.billing}`,
            engineApi: createIntegrationsEngine().client,
        });
        await app.user.click(await screen.findByRole('button', { name: 'Edit' }));
        const dialog = await screen.findByRole('dialog', { name: 'Edit Billing repository' }, DIALOG_WAIT);
        expect(await within(dialog).findByRole('checkbox', { name: 'GITHUB_TOKEN (missing)' })).toHaveProperty(
            'checked',
            true,
        );
        expect(within(dialog).queryByRole('textbox', { name: /^GitHub repository/ })).toBeNull();
    });
});

describe('secret values never pass through this feature', { timeout: 60_000 }, () => {
    function canary(): string {
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        return `canary-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }

    async function seedCanary(engine: IntegrationsEngine, value: string) {
        const signal = AbortSignal.timeout(5_000);
        const secret = await engine.client.secrets.create(
            { name: 'CANARY_TOKEN', scope: { kind: 'engine' }, value },
            signal,
        );
        if (secret.kind !== 'ok') throw new Error('expected a secret');
        const integration = await engine.client.integrations.create(
            {
                kind: 'mcp-server',
                name: 'Canary server',
                url: 'https://canary.example.com/mcp',
                secretNames: ['CANARY_TOKEN'],
            },
            signal,
        );
        if (integration.kind !== 'ok') throw new Error('expected an integration');
        return integration.data.id;
    }

    it('keeps the canary out of the page, its attributes, the query cache and every toast', async () => {
        const value = canary();
        const engine = createIntegrationsEngine();
        const integrationId = await seedCanary(engine, value);
        const app = renderWithProviders({ path: '/integrations', engineApi: engine.client });
        const seen: string[] = [];
        const look = () => {
            // Serialised with attributes, so a value in an `href`, `value` or `data-*` would show too.
            seen.push(new XMLSerializer().serializeToString(document.body));
            seen.push(
                JSON.stringify(
                    app.queryClient
                        .getQueryCache()
                        .getAll()
                        .map((query) => query.state.data),
                ),
            );
        };

        await within(await screen.findByRole('table')).findByText('Canary server');
        look();
        await app.user.click(screen.getByRole('button', { name: 'Add MCP server' }));
        await within(await screen.findByRole('dialog', { name: 'Add MCP server' }, DIALOG_WAIT)).findByRole(
            'checkbox',
            {
                name: 'CANARY_TOKEN',
            },
        );
        look();
        await app.user.click(screen.getByRole('button', { name: 'Cancel' }));

        await app.router.navigate({ to: '/integrations/$integrationId', params: { integrationId } });
        await screen.findByRole('heading', { level: 1, name: 'Canary server' });
        await screen.findByRole('list', { name: 'Recent activity' });
        look();
        await app.user.click(screen.getByRole('button', { name: 'Edit' }));
        const dialog = await screen.findByRole('dialog', { name: 'Edit Canary server' }, DIALOG_WAIT);
        await app.user.click(within(dialog).getByRole('button', { name: 'Save' }));
        await screen.findByText('Canary server saved');
        await app.user.click(screen.getByRole('button', { name: 'Check connection' }));
        await screen.findByText(/^Canary server: /);
        look();

        expect(seen.join('\n')).toContain('CANARY_TOKEN');
        expect(seen.join('\n')).not.toContain(value);
    });
});
