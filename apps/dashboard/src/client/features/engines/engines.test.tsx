import vectors from '@ptbk/ui/fingerprint-vectors.json';
import { EngineId } from '@ptbk/protocol';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes, type EngineView } from '../../../shared/api/routes';
import { createApiClient } from '../../api/api-client';
import { ENGINE_REFETCH_MS, engineQuery, enginesQuery } from '../../api/queries';
import { expectNoAxeViolations } from '../../testing/axe';
import { AUTHENTICATION_OPTIONS, ENGINE_DOMAIN, ENGINE_ID, engineView, NOW, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { createScriptedApi, ok, problem } from '../../testing/scripted-api';

const OWNER = session({
    permissions: ['org.read', 'billing.read', 'billing.manage', 'engine.link', 'engine.read', 'engine.revoke'],
});
const OTHER_ID = 'q4ndy7ejw3zkp6ftr2hcm5sxlg';
const OPEN_NAME = /^Open engine/;

function engines(...list: EngineView[]) {
    return (api: ReturnType<typeof createScriptedApi>) => api.on(apiRoutes.listEngines, ok({ engines: list }));
}

function engine(view: EngineView) {
    return (api: ReturnType<typeof createScriptedApi>) => api.on(apiRoutes.getEngine, ok({ engine: view }));
}

/** Every attribute that names the engine domain, except the `href` of a link: what a page could load from it. */
function engineDomainReferences(root: Element): string[] {
    return [root, ...root.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes]
            .filter((attribute) => attribute.value.includes(ENGINE_DOMAIN))
            .filter((attribute) => !(element.tagName === 'A' && attribute.name === 'href'))
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
        const app = renderApp({ path: '/engines' });
        expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/signin');
        expect(app.history.location.search).toContain('returnTo=%2Fengines');
    });

    it('is where a signed-in person lands', async () => {
        const app = renderApp({ path: '/', session: OWNER, script: engines(engineView()) });
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/engines');
        expect(screen.getByRole('link', { name: 'Engines' }).getAttribute('aria-current')).toBe('page');
    });

    it('shows an empty state instead of an empty table, with linking an engine as the next step', async () => {
        const app = renderApp({ path: '/engines', session: OWNER });
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

    it('shows each engine’s status, fingerprint, address and heartbeat numbers', async () => {
        const app = renderApp({
            path: '/engines',
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
        expect(row.getByRole('button', { name: `Copy engine ID ${ENGINE_ID.slice(0, 8)}` })).toBeTruthy();
        expect(row.getByText(`${ENGINE_ID}.${ENGINE_DOMAIN}`)).toBeTruthy();
        expect(row.getByText('30 seconds ago').getAttribute('datetime')).toBe(new Date(NOW - 30_000).toISOString());
        expect(row.getByText('1.4.2')).toBeTruthy();
        expect(row.getByText('Update available')).toBeTruthy();
        expect(row.getByText('40%')).toBeTruthy();
        expect(row.getByText('70%')).toBeTruthy();
        expect(row.getByText('Medium')).toBeTruthy();
        expect(within(second).getByText('Waiting for first heartbeat')).toBeTruthy();
        expect(within(second).getByText('Never')).toBeTruthy();
        expect(within(second).getAllByText('Not reported').length).toBeGreaterThan(0);
        await expectNoAxeViolations(app.container);
    });

    it('renders an engine whose status could not be read as unknown, not as an error', async () => {
        renderApp({
            path: '/engines',
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
        renderApp({
            path: '/engines',
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
        expect(await screen.findByText('Revoked')).toBeTruthy();
        expect(screen.getByText('Suspended')).toBeTruthy();
        expect(screen.queryByRole('link', { name: OPEN_NAME })).toBeNull();
    });

    it('opens an engine at its exact address in a new tab, without opener or referrer', async () => {
        renderApp({ path: '/engines', session: OWNER, script: engines(engineView()) });
        await screen.findByText('Online');
        const open = screen.getByRole('link', { name: `Open engine ${ENGINE_ID.slice(0, 8)}, in a new tab` });
        expect(open.getAttribute('href')).toBe(`https://${ENGINE_ID}.${ENGINE_DOMAIN}/`);
        expect(open.getAttribute('target')).toBe('_blank');
        expect(open.getAttribute('rel')).toBe('noopener noreferrer');
        expect(open.getAttribute('referrerpolicy')).toBe('no-referrer');
    });

    it('says when the list cannot be loaded, with a retry', async () => {
        const app = renderApp({
            path: '/engines',
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
        renderApp({ path: '/engines', session: session({ permissions: ['org.read', 'engine.read'] }) });
        expect(await screen.findByRole('heading', { name: 'No engines yet', level: 2 })).toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Link an engine' })).toBeNull();
    });

    it('tells a role without engine.read that it cannot see engines, without asking the API', async () => {
        const app = renderApp({ path: '/engines', session: session({ permissions: ['org.read'] }) });
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
        expect(await screen.findByRole('heading', { name: `Engine ${ENGINE_ID.slice(0, 8)}`, level: 1 })).toBeTruthy();
        expect(screen.getByText(/security page shows the same pattern and code/)).toBeTruthy();
        expect(screen.getByText(ENGINE_ID)).toBeTruthy();
        expect(screen.getByText(`${ENGINE_ID}.${ENGINE_DOMAIN}`)).toBeTruthy();
        expect(screen.getByText('agents.customer.test')).toBeTruthy();
        expect(screen.getByText('Through Promptbook relays')).toBeTruthy();
        const heartbeat = screen.getByRole('heading', { name: 'Last heartbeat' }).closest('section') as HTMLElement;
        for (const text of ['1,760,000,000,123', '1.4.2', '3 h 25 min', '40%', '70%', 'Medium', 'Update available']) {
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
        app.unmount();
        const invalid = renderApp({ path: '/engines/not-an-engine', session: OWNER });
        expect(await screen.findByRole('heading', { name: 'Engine not found', level: 1 })).toBeTruthy();
        expect(invalid.api.callsTo(apiRoutes.getEngine)).toHaveLength(0);
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

describe('reachability', () => {
    const id = (value: string) => value as EngineView['engineId'];
    const NOT_REACHABLE = 'Not reachable: no relay connection';

    it('shows in the list how many relays reach each online engine, and nothing without presence data', async () => {
        renderApp({
            path: '/engines',
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
        expect(screen.getByText('Reachability')).toBeTruthy();
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
        expect(screen.queryByText('Reachability')).toBeNull();
        expect(screen.queryByText(/^Reachable through|^Not reachable/)).toBeNull();
    });
});

describe('fingerprint', () => {
    const engineIds = vectors.vectors.map((vector) => vector.engineId);

    it('renders every shared vector’s code in the list, in the mark’s accessible name and as text', async () => {
        renderApp({
            path: '/engines',
            session: OWNER,
            script: engines(
                ...engineIds.map((engineId) => engineView({ engineId: engineId as EngineView['engineId'] })),
            ),
        });
        await screen.findAllByText('Online');
        for (const vector of vectors.vectors) {
            const mark = screen.getByRole('img', { name: new RegExp(`fingerprint ${vector.formatted}$`) });
            expect(mark.textContent).toBe(vector.formatted);
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
        const app = renderApp({ path: '/engines', session: OWNER, script: engines(engineView()) });
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
        const app = renderApp({ path: '/engines', apiClient });
        await app.user.click(await screen.findByRole('link', { name: `${ENGINE_ID.slice(0, 8)}…` }));
        await screen.findByRole('heading', { name: 'Last heartbeat' });
        expect(fetched).toContain(`/api/engines/${ENGINE_ID}`);
        expect(fetched.filter((path) => !path.startsWith('/api/'))).toEqual([]);
        expectOnlyLinksToEngines();
    });
});

describe('revoke', () => {
    function revokable() {
        return renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: OWNER,
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

    it('explains recovery and sends the request only after the engine ID’s first characters are typed', async () => {
        const app = revokable();
        await app.user.click(await screen.findByRole('button', { name: 'Revoke engine' }));
        const dialog = await screen.findByRole('dialog', { name: `Revoke engine ${ENGINE_ID.slice(0, 8)}?` });
        for (const text of [
            /within minutes/,
            /permanent for this engine ID/,
            /new key/,
            /owner reset on the engine/,
            /new link code/,
            /passkeys for the old address/,
        ]) {
            expect(within(dialog).getByText(text)).toBeTruthy();
        }
        const confirm = within(dialog).getByRole('button', { name: 'Revoke permanently' });
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

    it('runs the step-up when the API asks for one, then revokes', async () => {
        const app = revokable();
        app.api.once(apiRoutes.revokeEngine, problem(403, 'step-up-required'));
        await app.user.click(await screen.findByRole('button', { name: 'Revoke engine' }));
        const dialog = await screen.findByRole('dialog', { name: /Revoke engine/ });
        await app.user.type(within(dialog).getByRole('textbox'), ENGINE_ID.slice(0, 8));
        await app.user.click(within(dialog).getByRole('button', { name: 'Revoke permanently' }));
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await app.user.click(within(stepUp).getByRole('button', { name: 'Use passkey' }));
        expect(await screen.findByText('Engine revoked')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.revokeEngine)).toHaveLength(2);
        expect(app.api.callsTo(apiRoutes.stepUpVerify)).toHaveLength(1);
    });

    it('explains the recovery cooldown and changes nothing', async () => {
        const app = renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session({
                permissions: ['org.read', 'engine.read', 'engine.revoke'],
                recoveryCooldownEndsAt: NOW + 3_600_000,
            }),
            script: (api) => {
                engine(engineView())(api);
                api.on(apiRoutes.revokeEngine, problem(403, 'recovery-cooldown'));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Revoke engine' }));
        const dialog = await screen.findByRole('dialog', { name: /Revoke engine/ });
        await app.user.type(within(dialog).getByRole('textbox'), ENGINE_ID.slice(0, 8));
        await app.user.click(within(dialog).getByRole('button', { name: 'Revoke permanently' }));
        expect(await screen.findByText(/recovered/i)).toBeTruthy();
        expect(screen.getAllByText('Online').length).toBeGreaterThan(0);
    });
});
