import vectors from '@ptbk/protocol/fingerprint-vectors.json';
import { EngineId } from '@ptbk/protocol';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes, type EngineView, type TeamView } from '../../../shared/api/routes';
import { createApiClient } from '../../api/api-client';
import { ENGINE_REFETCH_MS, engineQuery, enginesQuery } from '../../api/queries';
import { expectNoAxeViolations } from '../../testing/axe';
import {
    AUTHENTICATION_OPTIONS,
    ENGINE_DOMAIN,
    ENGINE_ID,
    engineView,
    INSTALL_GUIDE_URL,
    NOW,
    session,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { createScriptedApi, ok, problem } from '../../testing/scripted-api';

const OWNER_PERMISSIONS = {
    permissions: [
        'org.read',
        'billing.read',
        'billing.manage',
        'engine.link',
        'engine.read',
        'engine.rename',
        'engine.revoke',
    ],
};
const OWNER = session(OWNER_PERMISSIONS);
const OTHER_ID = 'q4ndy7ejw3zkp6ftr2hcm5sxlg';
const OPEN_NAME = /^Open engine/;

function engines(...list: EngineView[]) {
    return (api: ReturnType<typeof createScriptedApi>) => api.on(apiRoutes.listEngines, ok({ engines: list }));
}

function engine(view: EngineView) {
    return (api: ReturnType<typeof createScriptedApi>) => api.on(apiRoutes.getEngine, ok({ engine: view }));
}

/**
 * Every attribute that names the engine domain, except the `href` of a link and a `title` (a tooltip, plain text): what
 * a page could load from it.
 */
function engineDomainReferences(root: Element): string[] {
    return [root, ...root.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes]
            .filter((attribute) => attribute.value.includes(ENGINE_DOMAIN))
            .filter((attribute) => !(element.tagName === 'A' && attribute.name === 'href'))
            .filter((attribute) => attribute.name !== 'title')
            .map((attribute) => `${element.tagName.toLowerCase()}[${attribute.name}]`),
    );
}

function expectOnlyLinksToEngines(): void {
    expect(engineDomainReferences(document.documentElement)).toEqual([]);
    expect(
        document.querySelectorAll(
            'link[rel~="prefetch"], link[rel~="preconnect"], link[rel~="dns-prefetch"], link[rel~="preload"]',
        ),
    ).toHaveLength(0);
    for (const anchor of document.querySelectorAll(`a[href*="${ENGINE_DOMAIN}"]`)) {
        expect(anchor.getAttribute('target')).toBe('_blank');
        expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
        expect(anchor.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(anchor.hasAttribute('ping')).toBe(false);
    }
}

describe('engine list', () => {
    it('sends a signed-out visitor to sign in first', async () => {
        const app = renderApp({ path: '/engines/all' });
        expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/signin');
        expect(app.history.location.search).toContain('returnTo=%2Fengines');
    });

    it('is still reachable by its address, without a navigation entry of its own (teams replace it)', async () => {
        renderApp({ path: '/engines/all', session: OWNER, script: engines(engineView()) });
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Engines' })).toBeNull();
    });

    it('shows an empty state instead of an empty table, with linking an engine as the next step', async () => {
        const app = renderApp({ path: '/engines/all', session: OWNER });
        expect(await screen.findByRole('heading', { name: 'No engines yet', level: 2 })).toBeTruthy();
        expect(screen.queryByRole('table')).toBeNull();
        expect(screen.queryByRole('columnheader')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Columns' })).toBeNull();
        expect(screen.getAllByRole('link', { name: 'Link an engine' })).toHaveLength(1);
        await expectNoAxeViolations(app.container);
        await app.user.click(screen.getByRole('link', { name: 'Link an engine' }));
        expect(await screen.findByRole('heading', { name: 'Link an engine', level: 1 })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/engines/new');
    });

    it('shows each engine on one line: fingerprint, status with last seen, address and version', async () => {
        const app = renderApp({
            path: '/engines/all',
            session: OWNER,
            script: engines(
                engineView(),
                engineView({
                    engineId: OTHER_ID as EngineView['engineId'],
                    status: 'never-seen',
                    lastSeenAt: null,
                    heartbeat: null,
                }),
            ),
        });
        await screen.findAllByText('Online');
        const table = screen.getByRole('table', { name: 'Engines of this organization' });
        const [, first, second] = within(table).getAllByRole('row');
        if (first === undefined || second === undefined) throw new Error('two rows');
        const row = within(first);
        expect(row.getByText('Online')).toBeTruthy();
        expect(row.getByRole('link', { name: `${ENGINE_ID.slice(0, 8)}…` }).getAttribute('href')).toBe(
            `/engines/${ENGINE_ID}`,
        );
        const address = row.getByText(`${ENGINE_ID}.${ENGINE_DOMAIN}`);
        // One line, cut off with an ellipsis when narrow, the full address in the tooltip and the copy button.
        expect(address.className).toContain('truncate');
        expect(address.getAttribute('title')).toBe(`${ENGINE_ID}.${ENGINE_DOMAIN}`);
        expect(row.getByRole('button', { name: 'Copy address' })).toBeTruthy();
        expect(row.getByText('just now').getAttribute('datetime')).toBe(new Date(NOW - 30_000).toISOString());
        expect(row.getByText('1.4.2')).toBeTruthy();
        expect(row.getByText('Update available')).toBeTruthy();
        // The heartbeat's numbers are on the engine's page, not in the list.
        for (const text of ['40%', '70%', 'Medium']) expect(row.queryByText(text)).toBeNull();
        expect(
            within(table)
                .getAllByRole('columnheader')
                .map((header) => header.textContent),
        ).toEqual(['Engine', 'Status', 'Address', 'Version']);
        expect(within(second).getByText('Waiting for first heartbeat')).toBeTruthy();
        expect(within(second).getByText('Never')).toBeTruthy();
        expect(within(second).queryByText('Update available')).toBeNull();
        await expectNoAxeViolations(app.container);
    });

    it('labels an online engine without an owner, still with its reachability', async () => {
        const base = engineView();
        renderApp({
            path: '/engines/all',
            session: OWNER,
            script: engines(
                engineView({
                    status: 'owner-pending',
                    heartbeat: base.heartbeat === null ? null : { ...base.heartbeat, members: 0 },
                    reachableRelays: 2,
                }),
            ),
        });
        expect(await screen.findByText('Owner not set up')).toBeTruthy();
        expect(screen.queryByText('Online')).toBeNull();
        expect(screen.getByText('Reachable through 2 relays')).toBeTruthy();
    });

    it('renders an engine whose status could not be read as unknown, not as an error', async () => {
        renderApp({
            path: '/engines/all',
            session: OWNER,
            script: engines(
                engineView({ status: 'unknown', lastSeenAt: null, heartbeat: null }),
                engineView({ engineId: OTHER_ID as EngineView['engineId'] }),
            ),
        });
        expect(await screen.findByText('Status unknown')).toBeTruthy();
        expect(screen.getByText('Online')).toBeTruthy();
        expect(screen.queryByText('The engines could not be loaded.')).toBeNull();
        expect(screen.queryByText('Something went wrong')).toBeNull();
    });

    it('shows revoked and suspended engines without an Open link', async () => {
        const app = renderApp({
            path: '/engines/all',
            session: OWNER,
            script: engines(
                engineView({ status: 'suspended', suspendedBy: 'owner' }),
                engineView({
                    engineId: OTHER_ID as EngineView['engineId'],
                    status: 'suspended',
                    suspendedBy: 'platform',
                }),
            ),
        });
        expect(await screen.findByText('Suspended')).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Show revoked engines (1)' }));
        expect(screen.getByText('Revoked')).toBeTruthy();
        expect(screen.queryByRole('link', { name: OPEN_NAME })).toBeNull();
    });

    it('lists engines by what needs attention, and keeps revoked ones behind a toggle', async () => {
        const app = renderApp({
            path: '/engines/all',
            session: OWNER,
            script: engines(
                engineView({
                    engineId: 'r'.repeat(26) as EngineView['engineId'],
                    status: 'suspended',
                    suspendedBy: 'owner',
                }),
                engineView({ engineId: 'n'.repeat(26) as EngineView['engineId'] }),
                engineView({ engineId: 'f'.repeat(26) as EngineView['engineId'], status: 'offline' }),
            ),
        });
        await screen.findByText('Offline');
        const table = screen.getByRole('table', { name: 'Engines of this organization' });
        const names = () =>
            within(table)
                .getAllByRole('link', { name: /…$/ })
                .map((link) => link.textContent);
        expect(names()).toEqual(['ffffffff…', 'nnnnnnnn…']);
        const toggle = screen.getByRole('button', { name: 'Show revoked engines (1)' });
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        await app.user.click(toggle);
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(names()).toEqual(['ffffffff…', 'nnnnnnnn…', 'rrrrrrrr…']);
    });

    it('shows a list of revoked engines only without hiding them', async () => {
        renderApp({
            path: '/engines/all',
            session: OWNER,
            script: engines(engineView({ status: 'suspended', suspendedBy: 'owner' })),
        });
        expect(await screen.findByText('Revoked')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Show revoked engines/ })).toBeNull();
    });

    it('mutes what an offline engine last reported and drops its stale update notice', async () => {
        renderApp({ path: '/engines/all', session: OWNER, script: engines(engineView({ status: 'offline' })) });
        await screen.findByText('Offline');
        expect(screen.getByText('1.4.2').className).toContain('text-text-muted');
        expect(screen.queryByText('Update available')).toBeNull();
    });

    it('opens an engine at its exact address in a new tab, without opener or referrer', async () => {
        renderApp({ path: '/engines/all', session: OWNER, script: engines(engineView()) });
        await screen.findByText('Online');
        const open = screen.getByRole('link', { name: `Open engine ${ENGINE_ID.slice(0, 8)}…, in a new tab` });
        expect(open.getAttribute('href')).toBe(`https://${ENGINE_ID}.${ENGINE_DOMAIN}/`);
        expect(open.getAttribute('target')).toBe('_blank');
        expect(open.getAttribute('rel')).toBe('noopener noreferrer');
        expect(open.getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('says when the list cannot be loaded, with a retry', async () => {
        const app = renderApp({
            path: '/engines/all',
            session: OWNER,
            // A contract breach is not retried, so the error shows at once.
            script: (api) => api.on(apiRoutes.listEngines, { kind: 'invalid-response', status: 200 }),
        });
        expect(await screen.findByText('The engines could not be loaded.')).toBeTruthy();
        app.api.on(apiRoutes.listEngines, ok({ engines: [engineView()] }));
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Online')).toBeTruthy();
    });

    it('offers no way to link an engine on the empty list without engine.link', async () => {
        renderApp({ path: '/engines/all', session: session({ permissions: ['org.read', 'engine.read'] }) });
        expect(await screen.findByRole('heading', { name: 'No engines yet', level: 2 })).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Link an engine' })).toBeNull();
    });

    it('tells a role without engine.read that it cannot see engines, without asking the API', async () => {
        const app = renderApp({ path: '/engines/all', session: session({ permissions: ['org.read'] }) });
        expect(await screen.findByText('Your role in this organization cannot see its engines.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.listEngines)).toHaveLength(0);
    });

    it('refreshes every minute while on screen and on focus, never in the background', () => {
        const api = createScriptedApi();
        for (const options of [enginesQuery(api), engineQuery(api, ENGINE_ID)]) {
            expect(options.refetchInterval).toBe(ENGINE_REFETCH_MS);
            expect(ENGINE_REFETCH_MS).toBe(60_000);
            expect(options.refetchIntervalInBackground).toBe(false);
            expect(options.refetchOnWindowFocus).toBe(true);
        }
    });
});

describe('engine page', () => {
    it('shows the registry data, the large fingerprint with its explanation, and the last heartbeat', async () => {
        const app = renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: engine(engineView({ customHostnames: ['agents.customer.test' as EngineView['hostname']] })),
        });
        expect(await screen.findByRole('heading', { name: `${ENGINE_ID.slice(0, 8)}…`, level: 1 })).toBeTruthy();
        expect(screen.getByText(/security page shows the same pattern and code/)).toBeTruthy();
        expect(screen.getByText(ENGINE_ID)).toBeTruthy();
        // Rendered label by label so a line breaks only after a dot; the text is still the exact address.
        const address = screen.getByRole('button', { name: 'Copy address' }).parentElement?.querySelector('code');
        expect(address?.textContent).toBe(`${ENGINE_ID}.${ENGINE_DOMAIN}`);
        expect(address?.querySelectorAll('wbr')).toHaveLength(3);
        expect(screen.getByText('agents.customer.test')).toBeTruthy();
        expect(screen.getByText('Through Promptbook relays')).toBeTruthy();
        const heartbeat = screen.getByRole('heading', { name: 'Last heartbeat' }).closest('section') as HTMLElement;
        for (const text of ['1760000000123', '1.4.2', '3 h 25 min', '40%', '70%', 'Medium', 'Update available']) {
            expect(within(heartbeat).getByText(text)).toBeTruthy();
        }
        expect(app.api.callsTo(apiRoutes.getEngine)).toEqual([{ params: { engineId: ENGINE_ID } }]);
        await expectNoAxeViolations(app.container);
    });

    it('renders an engine whose status could not be read as unknown, not as an error page', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: engine(engineView({ status: 'unknown', lastSeenAt: null, heartbeat: null })),
        });
        expect((await screen.findAllByText('Status unknown')).length).toBeGreaterThan(0);
        expect(screen.getByText(/could not be read just now/)).toBeTruthy();
        expect(screen.queryByText('Something went wrong')).toBeNull();
    });

    it('says not found for another organization’s engine and for anything that is not an engine ID', async () => {
        const app = renderApp({
            path: `/engines/${OTHER_ID}`,
            session: OWNER,
            script: (api) => api.on(apiRoutes.getEngine, problem(404, 'not-found')),
        });
        expect(await screen.findByRole('heading', { name: 'Engine not found', level: 1 })).toBeTruthy();
        expect(screen.getByText('This engine does not exist in this organization.')).toBeTruthy();
        await app.user.click(screen.getByRole('link', { name: 'Go to your engines' }));
        expect(app.history.location.pathname).toBe('/engines');
        app.unmount();
        const invalid = renderApp({ path: '/engines/not-an-engine', session: OWNER });
        expect(await screen.findByRole('heading', { name: 'Engine not found', level: 1 })).toBeTruthy();
        expect(invalid.api.callsTo(apiRoutes.getEngine)).toHaveLength(0);
    });

    it('suggests another organization when the person belongs to several', async () => {
        renderApp({
            path: `/engines/${OTHER_ID}`,
            session: session({
                ...OWNER_PERMISSIONS,
                memberships: [
                    { orgId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', kind: 'personal', name: null, role: 'owner' },
                    { orgId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', kind: 'team', name: 'Acme', role: 'owner' },
                ],
            }),
            script: (api) => api.on(apiRoutes.getEngine, problem(404, 'not-found')),
        });
        expect(await screen.findByText(/belongs to another of your organizations/)).toBeTruthy();
    });

    it('explains a revocation and offers neither Open nor Revoke', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: engine(engineView({ status: 'suspended', suspendedBy: 'owner' })),
        });
        expect(await screen.findByText(/You revoked this engine/)).toBeTruthy();
        expect(screen.queryByRole('link', { name: OPEN_NAME })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Revoke engine' })).toBeNull();
    });

    it('warns that an offline engine is not reporting, says when it was last seen once, and what to run', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: (api) => {
                engine(engineView({ status: 'offline', lastSeenAt: NOW - 2 * 3600_000 }))(api);
                api.on(apiRoutes.getInstallGuide, ok({ url: INSTALL_GUIDE_URL }));
            },
        });
        const banner = await screen.findByText('This engine is not reporting');
        // A warning, not a tip: announced as an alert.
        expect(banner.closest('[role="alert"]')).not.toBeNull();
        expect(screen.getByText('If its server is up, run this on it:')).toBeTruthy();
        expect(screen.getAllByText('2 hours ago')).toHaveLength(1);
        expect(screen.getByText('promptbook-engine status')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
        const guide = await screen.findByRole('link', { name: /Troubleshooting in the install guide/ });
        expect(guide.getAttribute('href')).toBe(`${INSTALL_GUIDE_URL}#troubleshooting`);
        expect(guide.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('keeps the offline hint without the guide link while the guide cannot be loaded', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: (api) => {
                engine(engineView({ status: 'offline' }))(api);
                api.on(apiRoutes.getInstallGuide, problem(500, 'internal'));
            },
        });
        expect(await screen.findByText('promptbook-engine status')).toBeTruthy();
        expect(screen.queryByRole('link', { name: /Troubleshooting/ })).toBeNull();
    });

    it('shows no offline hint for an engine that is online or has never been seen', async () => {
        const app = renderApp({ path: `/engines/${ENGINE_ID}`, session: OWNER, script: engine(engineView()) });
        expect(await screen.findByRole('heading', { name: 'Last heartbeat' })).toBeTruthy();
        expect(screen.queryByText(/If its server is up/)).toBeNull();
        app.unmount();
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: engine(engineView({ status: 'never-seen', lastSeenAt: null, heartbeat: null })),
        });
        expect(await screen.findByRole('heading', { name: 'Last heartbeat' })).toBeTruthy();
        expect(screen.queryByText(/If its server is up/)).toBeNull();
    });

    it('offers revocation only with engine.revoke', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session({ permissions: ['org.read', 'engine.read'] }),
            script: engine(engineView()),
        });
        expect(await screen.findByRole('heading', { name: 'Last heartbeat' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Revoke engine' })).toBeNull();
    });
});

describe('engine name', () => {
    const LABEL = 'Produkce – Brno' as NonNullable<EngineView['label']>;

    it('names a labelled engine by its label in the list, the title and the revoke dialog', async () => {
        const app = renderApp({
            path: '/engines/all',
            session: OWNER,
            script: (api) => {
                engines(
                    engineView({ label: LABEL }),
                    engineView({ engineId: OTHER_ID as EngineView['engineId'] }),
                )(api);
                engine(engineView({ label: LABEL }))(api);
            },
        });
        expect(await screen.findByRole('link', { name: `${OTHER_ID.slice(0, 8)}…` })).toBeTruthy();
        await app.user.click(screen.getByRole('link', { name: LABEL }));
        expect(await screen.findByRole('heading', { name: LABEL, level: 1 })).toBeTruthy();
        expect(screen.getByRole('link', { name: `Open engine ${LABEL}, in a new tab` })).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Revoke engine' }));
        const dialog = await screen.findByRole('dialog', { name: `Revoke engine ${LABEL}?` });
        expect(within(dialog).getByText(`Type ${ENGINE_ID.slice(0, 8)} to confirm`)).toBeTruthy();
    });

    const teamWith = (name: string): TeamView => ({
        teamId: 'tttttttttttttttttttttttttt',
        name: name as TeamView['name'],
        engineId: ENGINE_ID as TeamView['engineId'],
        memberCount: 1,
        isMember: true,
        createdAt: NOW,
    });

    it('titles an engine by the name its team was given, instead of its ID, with no second name to set', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session({ permissions: [...OWNER.activeOrg.permissions, 'engine.rename', 'team.read'] }),
            script: (api) => {
                engine(engineView())(api);
                api.on(apiRoutes.listTeams, ok({ teams: [teamWith('Northwind')] }));
            },
        });
        expect(await screen.findByRole('heading', { name: 'Northwind', level: 1 })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Name it' })).toBeNull();
    });

    it('opens through an access ticket for someone in the engine’s team, as the list does', async () => {
        const ticket = `https://${ENGINE_ID}.${ENGINE_DOMAIN}/auth/join#ticket`;
        const app = renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session({ permissions: ['engine.read', 'team.read'] }),
            script: (api) => {
                engine(engineView())(api);
                api.on(apiRoutes.listTeams, ok({ teams: [teamWith('Northwind')] }));
                api.on(apiRoutes.createAccessTicket, ok({ url: ticket, expiresAt: null }));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Open Northwind' }));
        await waitFor(() => {
            expect(app.navigations).toEqual([ticket]);
        });
        expect(screen.queryByRole('link', { name: /^Open engine/ })).toBeNull();
    });

    it('keeps the plain link for someone outside the engine’s team', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session({ permissions: ['engine.read', 'team.read'] }),
            script: (api) => {
                engine(engineView())(api);
                api.on(apiRoutes.listTeams, ok({ teams: [{ ...teamWith('Northwind'), isMember: false }] }));
            },
        });
        expect(await screen.findByRole('link', { name: 'Open engine Northwind, in a new tab' })).toBeTruthy();
    });

    it('keeps the engine label for a team only named after the engine’s hostname', async () => {
        const view = engineView();
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session({ permissions: [...OWNER.activeOrg.permissions, 'engine.rename', 'team.read'] }),
            script: (api) => {
                engine(view)(api);
                api.on(apiRoutes.listTeams, ok({ teams: [teamWith(view.hostname)] }));
            },
        });
        expect(await screen.findByRole('button', { name: 'Name it' })).toBeTruthy();
        expect(screen.getByRole('heading', { name: `${ENGINE_ID.slice(0, 8)}…`, level: 1 })).toBeTruthy();
    });

    it('saves a typed name as the API takes it, refuses one it would not, and clears it when emptied', async () => {
        const app = renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: (api) => {
                api.on(apiRoutes.getEngine, () => {
                    const last = api.callsTo(apiRoutes.renameEngine).at(-1) as
                        { body: { label: string | null } } | undefined;
                    return ok({ engine: engineView({ label: (last?.body.label ?? null) as EngineView['label'] }) });
                });
                api.on(apiRoutes.renameEngine, (input) => {
                    const { body } = input as { body: { label: string | null } };
                    return ok({ engine: engineView({ label: body.label as EngineView['label'] }) });
                });
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Name it' }));
        let dialog = await screen.findByRole('dialog', { name: 'Name this engine' });
        const field = within(dialog).getByRole('textbox', { name: 'Name' });
        await app.user.type(field, '<b>Prod</b>');
        await app.user.click(within(dialog).getByRole('button', { name: 'Save name' }));
        expect(await within(dialog).findByText(/Use up to 40 letters/)).toBeTruthy();
        expect(field.getAttribute('aria-invalid')).toBe('true');
        expect(app.api.callsTo(apiRoutes.renameEngine)).toEqual([]);
        await expectNoAxeViolations(dialog);

        await app.user.clear(field);
        await app.user.type(field, '  Produkce   –  Brno ');
        await app.user.click(within(dialog).getByRole('button', { name: 'Save name' }));
        expect(await screen.findByText('Name saved')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.renameEngine)).toEqual([
            { params: { engineId: ENGINE_ID }, body: { label: LABEL } },
        ]);
        expect(await screen.findByRole('heading', { name: LABEL, level: 1 })).toBeTruthy();
        expect(screen.queryByRole('dialog', { name: 'Name this engine' })).toBeNull();

        await app.user.click(screen.getByRole('button', { name: 'Rename' }));
        dialog = await screen.findByRole('dialog', { name: 'Rename engine' });
        await app.user.clear(within(dialog).getByRole('textbox', { name: 'Name' }));
        await app.user.click(within(dialog).getByRole('button', { name: 'Save name' }));
        expect(await screen.findByText('Name removed')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.renameEngine).at(-1)).toEqual({
            params: { engineId: ENGINE_ID },
            body: { label: null },
        });
        expect(await screen.findByRole('heading', { name: `${ENGINE_ID.slice(0, 8)}…`, level: 1 })).toBeTruthy();
    });

    it('closes without a request when the name did not change, and on Cancel', async () => {
        const app = renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: engine(engineView({ label: LABEL })),
        });
        await app.user.click(await screen.findByRole('button', { name: 'Rename' }));
        let dialog = await screen.findByRole('dialog', { name: 'Rename engine' });
        expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe(LABEL);
        await app.user.click(within(dialog).getByRole('button', { name: 'Save name' }));
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'Rename engine' })).toBeNull();
        });
        await app.user.click(screen.getByRole('button', { name: 'Rename' }));
        dialog = await screen.findByRole('dialog', { name: 'Rename engine' });
        await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: 'Rename engine' })).toBeNull();
        });
        expect(app.api.callsTo(apiRoutes.renameEngine)).toEqual([]);
    });

    it('offers no renaming without engine.rename', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session({ permissions: ['org.read', 'engine.read'] }),
            script: engine(engineView()),
        });
        expect(await screen.findByRole('heading', { name: `${ENGINE_ID.slice(0, 8)}…`, level: 1 })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Name it' })).toBeNull();
    });
});

describe('reachability', () => {
    const id = (value: string) => value as EngineView['engineId'];
    const NOT_REACHABLE = 'Not reachable: no relay connection';

    it('shows in the list how many relays reach each online engine, and nothing without presence data', async () => {
        renderApp({
            path: '/engines/all',
            session: OWNER,
            script: engines(
                engineView({ reachableRelays: 2 }),
                engineView({ engineId: id(OTHER_ID), reachableRelays: 1 }),
                engineView({ engineId: id('a2b3c4d5e6f7g2h3i4j5k6l7m2'), reachableRelays: 0 }),
                engineView({ engineId: id('b2c3d4e5f6g7h2i3j4k5l6m7n2'), reachableRelays: null }),
                engineView({
                    engineId: id('c2d3e4f5g6h7i2j3k4l5m6n7o2'),
                    status: 'offline',
                    reachableRelays: 0,
                }),
            ),
        });
        const table = await screen.findByRole('table');
        expect(await within(table).findByText('Reachable through 2 relays')).toBeTruthy();
        expect(within(table).getByText('Reachable through 1 relay')).toBeTruthy();
        // Only the online engine that no relay reports; never the offline one, nor the one without data.
        expect(within(table).getAllByText(NOT_REACHABLE)).toHaveLength(1);
        expect(within(table).getAllByText(/^Reachable through/)).toHaveLength(2);
    });

    it('shows on the engine page whether relays reach it', async () => {
        const app = renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: engine(engineView({ reachableRelays: 0 })),
        });
        expect(await screen.findByText(NOT_REACHABLE)).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('names the relay count on the engine page', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
            script: engine(engineView({ reachableRelays: 2 })),
        });
        expect(await screen.findByText('Reachable through 2 relays')).toBeTruthy();
    });

    it('leaves the engine page without a reachability line while relays report nothing', async () => {
        renderApp({ path: `/engines/${ENGINE_ID}`, session: OWNER, script: engine(engineView()) });
        expect(await screen.findByText('Through Promptbook relays')).toBeTruthy();
        expect(screen.queryByText(/^Reachable through|^Not reachable/)).toBeNull();
    });
});

describe('fingerprint', () => {
    const engineIds = vectors.vectors.map((vector) => vector.engineId);

    it('renders every shared vector’s pattern in the list, with its code in the mark’s accessible name', async () => {
        renderApp({
            path: '/engines/all',
            session: OWNER,
            script: engines(
                ...engineIds.map((engineId) => engineView({ engineId: engineId as EngineView['engineId'] })),
            ),
        });
        await screen.findAllByText('Online');
        for (const vector of vectors.vectors) {
            const mark = screen.getByRole('img', { name: new RegExp(`fingerprint ${vector.formatted}$`) });
            expect(mark.querySelector('[data-fingerprint]')?.getAttribute('data-fingerprint')).toBe(vector.patternBits);
        }
    });

    // Vectors that are not engine IDs ("a", "local-dev-engine-7") can never name an engine: the route says not found.
    it.each(vectors.vectors.filter((vector) => EngineId.safeParse(vector.engineId).success))(
        'renders the same code on the page of engine $engineId',
        async (vector) => {
            renderApp({
                path: `/engines/${vector.engineId}`,
                session: OWNER,
                script: engine(engineView({ engineId: vector.engineId as EngineView['engineId'] })),
            });
            const mark = await screen.findByRole('img', { name: new RegExp(vector.formatted) });
            expect(mark.textContent).toBe(vector.formatted);
            expect(mark.querySelector('svg')?.getAttribute('class')).toContain('size-20');
        },
    );
});

describe('engine domain', () => {
    it('appears in the list and on the engine page only as link targets', async () => {
        const app = renderApp({ path: '/engines/all', session: OWNER, script: engines(engineView()) });
        await screen.findByText('Online');
        expectOnlyLinksToEngines();
        app.unmount();
        renderApp({ path: `/engines/${ENGINE_ID}`, session: OWNER, script: engine(engineView()) });
        await screen.findByRole('heading', { name: 'Last heartbeat' });
        expectOnlyLinksToEngines();
    });

    it('is never a fetch target: the typed client calls only /api/*', async () => {
        const fetched: string[] = [];
        const answers: Readonly<Record<string, unknown>> = {
            '/api/environment': { environment: 'production' },
            '/api/session': OWNER,
            '/api/engines': { engines: [engineView()] },
            [`/api/engines/${ENGINE_ID}`]: { engine: engineView() },
        };
        const apiClient = createApiClient({
            fetch: (input) => {
                const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
                fetched.push(path);
                const body = answers[path];
                return Promise.resolve(
                    body === undefined
                        ? new Response(
                              JSON.stringify({
                                  type: 'about:blank',
                                  title: 'Not found',
                                  status: 404,
                                  code: 'not-found',
                              }),
                              {
                                  status: 404,
                                  headers: { 'Content-Type': 'application/problem+json' },
                              },
                          )
                        : new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }),
                );
            },
        });
        const app = renderApp({ path: '/engines/all', apiClient });
        await app.user.click(await screen.findByRole('link', { name: `${ENGINE_ID.slice(0, 8)}…` }));
        await screen.findByRole('heading', { name: 'Last heartbeat' });
        expect(fetched).toContain(`/api/engines/${ENGINE_ID}`);
        expect(fetched.filter((path) => !path.startsWith('/api/'))).toEqual([]);
        expectOnlyLinksToEngines();
    });
});

describe('revoke', () => {
    function revokable(options: { readonly steppedUpUntil?: number } = {}) {
        return renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session({ ...OWNER_PERMISSIONS, steppedUpUntil: options.steppedUpUntil ?? null }),
            script: (api) => {
                const revoked = engineView({ status: 'suspended', suspendedBy: 'owner' });
                // The server answers the revoked engine from then on, as the refetch after the mutation shows.
                api.on(apiRoutes.getEngine, () =>
                    ok({ engine: api.callsTo(apiRoutes.revokeEngine).length > 0 ? revoked : engineView() }),
                );
                api.on(apiRoutes.revokeEngine, ok({ engine: revoked }));
                api.on(apiRoutes.stepUpOptions, ok({ options: AUTHENTICATION_OPTIONS }));
                api.on(apiRoutes.stepUpVerify, ok({ steppedUpUntil: NOW + 300_000 }));
            },
        });
    }

    async function confirmIn(app: ReturnType<typeof revokable>, button: string | RegExp) {
        await app.user.click(await screen.findByRole('button', { name: 'Revoke engine' }));
        const dialog = await screen.findByRole('dialog', { name: /^Revoke engine/ });
        await app.user.type(within(dialog).getByRole('textbox'), ENGINE_ID.slice(0, 8));
        await app.user.click(within(dialog).getByRole('button', { name: button }));
        return dialog;
    }

    it('states the consequence and sends the request only after the engine ID’s first characters are typed', async () => {
        const app = revokable();
        await app.user.click(await screen.findByRole('button', { name: 'Revoke engine' }));
        const dialog = await screen.findByRole('dialog', { name: `Revoke engine ${ENGINE_ID.slice(0, 8)}…?` });
        expect(within(dialog).getByText(/within minutes. This cannot be undone/)).toBeTruthy();
        expect(
            within(dialog)
                .getAllByRole('listitem')
                .map((item) => item.textContent),
        ).toEqual([expect.stringMatching(/address stops working/), expect.stringMatching(/link it with a new code/)]);
        const confirm = within(dialog).getByRole('button', { name: 'Revoke with passkey' });
        expect((confirm as HTMLButtonElement).disabled).toBe(true);
        await app.user.type(within(dialog).getByRole('textbox'), ENGINE_ID.slice(0, 7));
        expect((confirm as HTMLButtonElement).disabled).toBe(true);
        await app.user.click(confirm);
        expect(app.api.callsTo(apiRoutes.revokeEngine)).toHaveLength(0);
        await expectNoAxeViolations(dialog);
        await app.user.type(within(dialog).getByRole('textbox'), ENGINE_ID.charAt(7));
        await app.user.click(confirm);
        expect(await screen.findByText('Engine revoked')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.revokeEngine)).toEqual([{ params: { engineId: ENGINE_ID } }]);
        await waitFor(() => {
            expect(screen.queryByRole('dialog', { name: /Revoke engine/ })).toBeNull();
        });
        expect(await screen.findByText(/You revoked this engine/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Revoke engine' })).toBeNull();
    });

    it('runs the passkey check from the confirm button, without a second dialog on top', async () => {
        const app = revokable();
        await confirmIn(app, 'Revoke with passkey');
        expect(await screen.findByText('Engine revoked')).toBeTruthy();
        expect(screen.queryByRole('dialog', { name: 'Confirm it is you' })).toBeNull();
        expect(app.passkeys.authenticate).toHaveBeenCalledOnce();
        expect(app.api.callsTo(apiRoutes.stepUpVerify)).toHaveLength(1);
        expect(app.api.callsTo(apiRoutes.revokeEngine)).toHaveLength(1);
    });

    it('asks for no passkey within the step-up window', async () => {
        const app = revokable({ steppedUpUntil: NOW + 120_000 });
        await confirmIn(app, 'Revoke permanently');
        expect(await screen.findByText('Engine revoked')).toBeTruthy();
        expect(app.passkeys.authenticate).not.toHaveBeenCalled();
        expect(app.api.callsTo(apiRoutes.stepUpOptions)).toEqual([]);
    });

    it('still checks in place when the API asks for a step-up the session did not expect', async () => {
        const app = revokable({ steppedUpUntil: NOW + 120_000 });
        app.api.once(apiRoutes.revokeEngine, problem(403, 'step-up-required'));
        await confirmIn(app, 'Revoke permanently');
        expect(await screen.findByText('Engine revoked')).toBeTruthy();
        expect(screen.queryByRole('dialog', { name: 'Confirm it is you' })).toBeNull();
        expect(app.api.callsTo(apiRoutes.stepUpVerify)).toHaveLength(1);
        expect(app.api.callsTo(apiRoutes.revokeEngine)).toHaveLength(2);
    });

    it('says in the dialog why the passkey check failed, sends nothing, and tries again from the same button', async () => {
        const app = revokable();
        app.passkeys.failNext('cancelled');
        const dialog = await confirmIn(app, 'Revoke with passkey');
        expect(await within(dialog).findByRole('alert')).toBeTruthy();
        expect(within(dialog).getByText(/passkey prompt was closed/)).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.revokeEngine)).toEqual([]);
        expect(screen.queryByText('Engine revoked')).toBeNull();
        await app.user.click(within(dialog).getByRole('button', { name: 'Revoke with passkey' }));
        expect(await screen.findByText('Engine revoked')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.revokeEngine)).toHaveLength(1);
    });

    it('explains the recovery cooldown and changes nothing', async () => {
        const app = renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session({
                permissions: ['org.read', 'engine.read', 'engine.revoke'],
                recoveryCooldownEndsAt: NOW + 3_600_000,
                steppedUpUntil: NOW + 120_000,
            }),
            script: (api) => {
                engine(engineView())(api);
                api.on(apiRoutes.revokeEngine, problem(403, 'recovery-cooldown'));
            },
        });
        await confirmIn(app, 'Revoke permanently');
        expect(await screen.findByText(/recovered/i)).toBeTruthy();
        expect(screen.getAllByText('Online').length).toBeGreaterThan(0);
    });
});
