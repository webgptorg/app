import {
    ClientInfo,
    createFetchEngineApiClient,
    ENGINE_API_PREFIX,
    MemberId,
    OWNER_PERMISSIONS,
    SessionId,
} from '@ptbk/engine-api';
import type { EngineApiClient, Permission } from '@ptbk/engine-api';
import { createEngineApiHttpHandler } from '@ptbk/engine-api/http';
import { createInMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import type { RenderedApp } from '../../testing/render-with-providers';
import { createSecurityEngine, documentText } from '../../testing/security-engine';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const CANARY = 'sk-CANARY-7f3a9c1e';

function secret(index: number) {
    const number = String(index).padStart(3, '0');
    return {
        id: `secret-${number}`,
        name: `SECRET_${number}`,
        scope: index % 3 === 0 ? { kind: 'agent' as const, agentId: 'agent-ada' } : { kind: 'engine' as const },
        status: index % 5 === 0 ? ('revoked' as const) : ('active' as const),
        createdBy: 'member-owner',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        lastUsedAt: null,
    };
}

function secretsEngine(options: { count?: number; permissions?: readonly Permission[]; stepUp?: 'required' } = {}) {
    const engine = createSecurityEngine({
        ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
        ...(options.stepUp === undefined ? {} : { stepUp: options.stepUp }),
        seed: { secrets: Array.from({ length: options.count ?? 3 }, (_, index) => secret(index + 1)) },
    });
    const secrets = { ...engine.client.secrets };
    const spies = {
        list: vi.spyOn(secrets, 'list'),
        create: vi.spyOn(secrets, 'create'),
        replaceValue: vi.spyOn(secrets, 'replaceValue'),
        revoke: vi.spyOn(secrets, 'revoke'),
        delete: vi.spyOn(secrets, 'delete'),
    };
    return { client: { ...engine.client, secrets }, spies };
}

function rowOf(cell: HTMLElement): HTMLElement {
    const row = cell.closest('tr');
    if (row === null) throw new Error('not in a table row');
    return row;
}

/** Everything the app keeps: rendered DOM (text, attributes, input values), both TanStack caches, and the toasts. */
function expectNowhere(app: RenderedApp, value: string) {
    expect(documentText()).not.toContain(value);
    const cached = (client: QueryClient) =>
        JSON.stringify([
            client
                .getQueryCache()
                .getAll()
                .map((query) => query.state),
            client
                .getMutationCache()
                .getAll()
                .map((mutation) => mutation.state),
        ]);
    expect(cached(app.queryClient)).not.toContain(value);
    expect(app.router.state.location.href).not.toContain(value);
}

async function openRowMenu(app: RenderedApp, name: string) {
    await app.user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
    return screen.getByRole('menu', { name: `Actions for ${name}` });
}

const valueInput = () => screen.getByLabelText<HTMLInputElement>(/^Value/);

describe('secrets: create', { timeout: TIMEOUT_MS }, () => {
    it('creates a secret whose value never reaches the DOM, the caches, the URL or a toast', async () => {
        const engine = secretsEngine();
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await screen.findByText('SECRET_001');
        await app.user.click(screen.getByRole('button', { name: 'New secret' }));
        const dialog = await screen.findByRole('dialog', { name: 'New secret' });
        await app.user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'GITHUB_TOKEN');
        const input = valueInput();
        expect(input.type).toBe('password');
        expect(input.getAttribute('autocomplete')).toBe('new-password');
        expect(input.getAttribute('spellcheck')).toBe('false');
        expect(within(dialog).queryByRole('button', { name: /show|reveal/i })).toBeNull();
        await app.user.type(input, CANARY);
        await app.user.click(within(dialog).getByRole('button', { name: 'Save secret' }));

        expect(await screen.findByText('Secret GITHUB_TOKEN saved')).toBeDefined();
        expect(await screen.findByText('GITHUB_TOKEN')).toBeDefined();
        expect(engine.spies.create).toHaveBeenCalledOnce();
        expect(engine.spies.create.mock.calls[0]?.[0]).toEqual({
            name: 'GITHUB_TOKEN',
            scope: { kind: 'engine' },
            value: CANARY,
        });
        expect(screen.queryByRole('dialog', { name: 'New secret' })).toBeNull();
        expectNowhere(app, CANARY);
    });

    it('marks a secret whose agent is deleted and does not link to the agent', async () => {
        const engine = createSecurityEngine({
            seed: {
                agents: [
                    { id: 'agent-ada', source: 'Ada' },
                    { id: 'agent-gone', source: 'Incident Responder', deletedAt: '2026-09-10T00:00:00Z' },
                ],
                secrets: [{ ...secret(3), scope: { kind: 'agent', agentId: 'agent-gone' } }, secret(6)],
            },
        });
        renderWithProviders({ path: '/secrets', engineApi: engine.client });
        const gone = within(rowOf(await screen.findByText('SECRET_003')));
        expect(await gone.findByText('Incident Responder')).toBeDefined();
        expect(gone.getByText('Deleted')).toBeDefined();
        expect(gone.queryByRole('link', { name: 'Incident Responder' })).toBeNull();
        const live = within(rowOf(screen.getByText('SECRET_006')));
        expect(await live.findByRole('link', { name: 'Ada' })).toBeDefined();
        expect(live.queryByText('Deleted')).toBeNull();
    });

    it('scopes a secret to one agent', async () => {
        const engine = secretsEngine();
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await app.user.click(await screen.findByRole('button', { name: 'New secret' }));
        const dialog = await screen.findByRole('dialog', { name: 'New secret' });
        await app.user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'ADA_KEY');
        await app.user.selectOptions(within(dialog).getByRole('combobox', { name: /^Scope/ }), 'agent');
        await app.user.click(within(dialog).getByRole('button', { name: 'Save secret' }));
        expect(await within(dialog).findByText('Choose the agent that may use it.')).toBeDefined();
        expect(within(dialog).getByText('Enter the value.')).toBeDefined();
        expect(engine.spies.create).not.toHaveBeenCalled();

        const agent = within(dialog).getByRole('combobox', { name: /^Agent/ });
        await within(agent).findByRole('option', { name: 'Ada' });
        await app.user.selectOptions(agent, 'agent-ada');
        await app.user.type(valueInput(), CANARY);
        await app.user.click(within(dialog).getByRole('button', { name: 'Save secret' }));
        expect(await screen.findByText('Secret ADA_KEY saved')).toBeDefined();
        expect(engine.spies.create.mock.calls[0]?.[0].scope).toEqual({ kind: 'agent', agentId: 'agent-ada' });
        expectNowhere(app, CANARY);
    });

    it('clears the value after a failed submit and keeps the dialog open', async () => {
        const engine = secretsEngine();
        engine.spies.create.mockImplementationOnce(() => problemResponse('name-taken'));
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await app.user.click(await screen.findByRole('button', { name: 'New secret' }));
        const dialog = await screen.findByRole('dialog', { name: 'New secret' });
        await app.user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'SECRET_001');
        await app.user.type(valueInput(), CANARY);
        await app.user.click(within(dialog).getByRole('button', { name: 'Save secret' }));

        expect(await screen.findByText('A secret named SECRET_001 already exists in that scope.')).toBeDefined();
        expect(screen.getByRole('dialog', { name: 'New secret' })).toBeDefined();
        expect(valueInput().value).toBe('');
        expectNowhere(app, CANARY);
    });
});

describe('secrets: replace, revoke, delete', { timeout: TIMEOUT_MS }, () => {
    it('replaces a value, reports it by name and clears the input', async () => {
        const engine = secretsEngine();
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        const menu = await openRowMenu(app, 'SECRET_001');
        await app.user.click(within(menu).getByRole('menuitem', { name: 'Replace value' }));
        const dialog = await screen.findByRole('dialog', { name: 'Replace the value of SECRET_001' });
        await app.user.type(valueInput(), CANARY);
        await app.user.click(within(dialog).getByRole('button', { name: 'Replace value' }));

        expect(await screen.findByText('Value of SECRET_001 replaced')).toBeDefined();
        expect(engine.spies.replaceValue.mock.calls[0]?.[1]).toEqual({ value: CANARY });
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'Replace the value of SECRET_001' })).toBeNull();
        });
        expectNowhere(app, CANARY);
    });

    it('clears a replaced value after the engine refuses it', async () => {
        const engine = secretsEngine();
        engine.spies.replaceValue.mockImplementationOnce(() => problemResponse('internal-error'));
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await app.user.click(
            within(await openRowMenu(app, 'SECRET_002')).getByRole('menuitem', { name: 'Replace value' }),
        );
        await app.user.type(valueInput(), CANARY);
        await app.user.click(screen.getByRole('button', { name: 'Replace value' }));
        expect(await screen.findByText('The value of SECRET_002 could not be replaced.')).toBeDefined();
        expect(valueInput().value).toBe('');
        expectNowhere(app, CANARY);
    });

    it('revokes after confirmation', async () => {
        const engine = secretsEngine();
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await app.user.click(within(await openRowMenu(app, 'SECRET_002')).getByRole('menuitem', { name: 'Revoke' }));
        const dialog = screen.getByRole('dialog', { name: 'Revoke SECRET_002?' });
        await app.user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
        expect(await screen.findByText('Secret SECRET_002 revoked')).toBeDefined();
        await waitFor(() => {
            expect(screen.getByText('SECRET_002').closest('tr')?.textContent).toContain('Revoked');
        });
        expect(engine.spies.revoke).toHaveBeenCalledOnce();
    });

    it('deletes only after the name is typed', async () => {
        const engine = secretsEngine();
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await app.user.click(within(await openRowMenu(app, 'SECRET_001')).getByRole('menuitem', { name: 'Delete' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete SECRET_001?' });
        const confirm = within(dialog).getByRole('button', { name: 'Delete' });
        expect(confirm.hasAttribute('disabled')).toBe(true);
        await app.user.type(within(dialog).getByRole('textbox'), 'SECRET_001');
        await app.user.click(confirm);
        expect(await screen.findByText('Secret SECRET_001 deleted')).toBeDefined();
        await waitFor(() => {
            expect(screen.queryByText('SECRET_001')).toBeNull();
        });
    });

    it('reports a failed revoke by name', async () => {
        const engine = secretsEngine();
        engine.spies.revoke.mockImplementationOnce(() => problemResponse('internal-error'));
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await app.user.click(within(await openRowMenu(app, 'SECRET_001')).getByRole('menuitem', { name: 'Revoke' }));
        await app.user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
        expect(await screen.findByText('Secret SECRET_001 could not be revoked.')).toBeDefined();
    });

    it('reports a failed delete by name and keeps the secret', async () => {
        const engine = secretsEngine();
        engine.spies.delete.mockImplementationOnce(() => problemResponse('internal-error'));
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await app.user.click(within(await openRowMenu(app, 'SECRET_001')).getByRole('menuitem', { name: 'Delete' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete SECRET_001?' });
        await app.user.type(within(dialog).getByRole('textbox'), 'SECRET_001');
        await app.user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        expect(await screen.findByText('Secret SECRET_001 could not be deleted.')).toBeDefined();
        expect(screen.getAllByText('SECRET_001').length).toBeGreaterThan(0);
    });

    it('starts again from the first page on an expired cursor', async () => {
        const engine = secretsEngine();
        engine.spies.list.mockImplementationOnce(() => problemResponse('invalid-cursor'));
        const app = renderWithProviders({ path: '/secrets?cursor=expired', engineApi: engine.client });
        expect(await screen.findByText('SECRET_001')).toBeDefined();
        expect((app.router.state.location.search as { cursor?: string }).cursor).toBeUndefined();
    });

    it('asks for a fresh passkey when the engine wants step-up', async () => {
        const engine = secretsEngine({ stepUp: 'required' });
        engine.spies.delete.mockImplementationOnce(() => problemResponse('step-up-required'));
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await app.user.click(within(await openRowMenu(app, 'SECRET_001')).getByRole('menuitem', { name: 'Delete' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete SECRET_001?' });
        await app.user.type(within(dialog).getByRole('textbox'), 'SECRET_001');
        await app.user.click(within(dialog).getByRole('button', { name: 'Delete' }));
        expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeDefined();
    });

    it('offers no actions without secrets.manage', async () => {
        const engine = secretsEngine({ permissions: OWNER_PERMISSIONS.filter((p) => p !== 'secrets.manage') });
        renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await screen.findByText('SECRET_001');
        expect(screen.queryByRole('button', { name: 'New secret' })).toBeNull();
        expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
    });
});

describe('secrets: list', { timeout: TIMEOUT_MS }, () => {
    it('pages through more than one server page and passes axe', async () => {
        const engine = secretsEngine({ count: 60 });
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await screen.findByText('SECRET_001');
        expect(screen.queryByText('SECRET_060')).toBeNull();
        await expectNoAxeViolations(app.container);
        await app.user.click(screen.getByRole('button', { name: 'Next page' }));
        expect(await screen.findByText('SECRET_060')).toBeDefined();
        expect(engine.spies.list).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: expect.any(String) as string }),
            expect.anything(),
        );
        await app.user.click(screen.getByRole('button', { name: 'Previous page' }));
        expect(await screen.findByText('SECRET_001')).toBeDefined();
    });

    it('sends search, filters, sort and cursor to the engine from the URL, as on a reload', async () => {
        const first = secretsEngine({ count: 60 });
        const app = renderWithProviders({ path: '/secrets', engineApi: first.client });
        await screen.findByText('SECRET_001');
        await app.user.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText('SECRET_060');
        const cursor = (app.router.state.location.search as { cursor?: string }).cursor ?? '';
        app.unmount();

        const engine = secretsEngine({ count: 60 });
        renderWithProviders({
            path: `/secrets?q=SECRET&scope=engine&status=active&sort=-createdAt&cursor=${cursor}`,
            engineApi: engine.client,
        });
        await waitFor(() => {
            expect(engine.spies.list).toHaveBeenCalledWith(
                { sort: '-createdAt', q: 'SECRET', scope: 'engine', status: 'active', cursor },
                expect.anything(),
            );
        });
        expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search secrets' }).value).toBe('SECRET');
    });

    it('filters on the engine when a filter changes', async () => {
        const engine = secretsEngine({ count: 10 });
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        await screen.findByText('SECRET_001');
        await app.user.selectOptions(screen.getByRole('combobox', { name: /State/ }), 'revoked');
        await waitFor(() => {
            expect(engine.spies.list).toHaveBeenLastCalledWith({ sort: 'name', status: 'revoked' }, expect.anything());
        });
        await waitFor(() => {
            expect(screen.queryByText('SECRET_001')).toBeNull();
        });
        expect(screen.getByText('SECRET_005')).toBeDefined();
    });

    it('shows the empty state with a way to add the first secret', async () => {
        const engine = secretsEngine({ count: 0 });
        renderWithProviders({ path: '/secrets', engineApi: engine.client });
        expect(await screen.findByText('No secrets yet')).toBeDefined();
        expect(screen.getAllByRole('button', { name: 'New secret' }).length).toBeGreaterThan(0);
    });

    it('shows an error with retry when the list fails', async () => {
        const engine = secretsEngine();
        engine.spies.list.mockImplementation(() => problemResponse('internal-error'));
        const app = renderWithProviders({ path: '/secrets', engineApi: engine.client });
        expect(await screen.findByText('The secrets could not be loaded.', {}, { timeout: 10_000 })).toBeDefined();
        engine.spies.list.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('SECRET_001')).toBeDefined();
    });
});

/**
 * A misbehaving engine that puts the value into secret responses. The fetch client's tolerant reader drops the field
 * before anything in the UI sees it (C-05's `engine-api.secrets.never-returned` is what catches such an engine).
 */
function leakingEngine(): EngineApiClient {
    const core = createInMemoryEngineCore({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            secrets: [secret(1)],
        },
    });
    const handler = createEngineApiHttpHandler(
        core.transport({
            memberId: MemberId.parse('member-owner'),
            sessionId: SessionId.parse('session-current'),
            client: ClientInfo.parse({ ip: '127.0.0.1', userAgent: 'test' }),
            permissions: new Set(OWNER_PERMISSIONS),
            stepUpFresh: true,
        }),
    );
    const leak = (item: unknown) => (typeof item === 'object' && item !== null ? { ...item, value: CANARY } : item);
    const fakeFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        const response = await handler(request);
        if (!new URL(request.url).pathname.startsWith(`${ENGINE_API_PREFIX}/secrets`) || response.status === 204) {
            return response;
        }
        const body = (await response.json()) as { items?: unknown[] };
        const leaked = Array.isArray(body.items) ? { ...body, items: body.items.map(leak) } : leak(body);
        return new Response(JSON.stringify(leaked), { status: response.status, headers: response.headers });
    };
    return createFetchEngineApiClient({ baseUrl: 'https://engine.localhost', fetch: fakeFetch, timeoutMs: 5_000 });
}

describe('secrets: a misbehaving engine', { timeout: TIMEOUT_MS }, () => {
    it('never exposes a value an engine leaks in its responses', async () => {
        const app = renderWithProviders({ path: '/secrets', engineApi: leakingEngine() });
        await screen.findByText('SECRET_001');
        await app.user.click(screen.getByRole('button', { name: 'New secret' }));
        const dialog = await screen.findByRole('dialog', { name: 'New secret' });
        await app.user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'LEAKY');
        await app.user.type(valueInput(), 'sk-typed-by-the-owner');
        await app.user.click(within(dialog).getByRole('button', { name: 'Save secret' }));
        expect(await screen.findByText('Secret LEAKY saved')).toBeDefined();
        expect(await screen.findByText('LEAKY')).toBeDefined();
        expectNowhere(app, CANARY);
        expectNowhere(app, 'sk-typed-by-the-owner');
    });
});
