import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../../shared/api/routes';
import { expectNoAxeViolations } from '../../../testing/axe';
import { adminEngineView, AUTHENTICATION_OPTIONS, ENGINE_ID, NOW, session } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render-app';
import { ok, problem, type ScriptedApi } from '../../../testing/scripted-api';

const ADMIN = session({ platformRole: 'admin' });
const PATH = `/admin/engines/${ENGINE_ID}`;
const SUSPENDED = adminEngineView({ status: 'suspended', suspendedBy: 'platform', updatedAt: NOW });
const REVOKED = adminEngineView({ status: 'suspended', suspendedBy: 'owner' });

function stepUp(api: ScriptedApi): void {
    api.on(apiRoutes.stepUpOptions, ok({ options: AUTHENTICATION_OPTIONS }));
    api.on(apiRoutes.stepUpVerify, ok({ steppedUpUntil: NOW + 300_000 }));
}

describe('engine page (platform admin)', () => {
    it('shows the engine and suspends it with a reason, after a step-up', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.adminGetEngine, () =>
                    ok({
                        engine: api.callsTo(apiRoutes.adminSuspendEngine).length > 1 ? SUSPENDED : adminEngineView(),
                    }),
                );
                api.once(apiRoutes.adminSuspendEngine, problem(403, 'step-up-required'));
                api.on(apiRoutes.adminSuspendEngine, ok({ engine: SUSPENDED }));
                stepUp(api);
            },
        });
        expect(await screen.findByText('Active')).toBeTruthy();
        expect(screen.getByText('bbbbbbbbbbbbbbbbbbbbbbbbbb')).toBeTruthy();
        await expectNoAxeViolations(app.container);

        await app.user.click(screen.getByRole('button', { name: 'Suspend engine' }));
        expect(await screen.findByText('Give a reason.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.adminSuspendEngine)).toHaveLength(0);

        await app.user.type(screen.getByRole('textbox', { name: /Reason/ }), '  Phishing report #42  ');
        await app.user.click(screen.getByRole('button', { name: 'Suspend engine' }));
        const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await app.user.click(within(dialog).getByRole('button', { name: 'Use passkey' }));
        expect(await screen.findByText('Engine suspended.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.adminSuspendEngine)).toEqual([
            { params: { engineId: ENGINE_ID }, body: { reason: 'Phishing report #42' } },
            { params: { engineId: ENGINE_ID }, body: { reason: 'Phishing report #42' } },
        ]);
        expect(await screen.findByText('Suspended by the platform')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Lift suspension' })).toBeTruthy();
    });

    it('lifts a platform suspension with a reason', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.adminGetEngine, () =>
                    ok({
                        engine: api.callsTo(apiRoutes.adminUnsuspendEngine).length > 0 ? adminEngineView() : SUSPENDED,
                    }),
                );
                api.on(apiRoutes.adminUnsuspendEngine, ok({ engine: adminEngineView() }));
            },
        });
        await app.user.type(await screen.findByRole('textbox', { name: /Reason/ }), 'Appeal accepted');
        await app.user.click(screen.getByRole('button', { name: 'Lift suspension' }));
        expect(await screen.findByText('Suspension lifted.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.adminUnsuspendEngine)).toEqual([
            { params: { engineId: ENGINE_ID }, body: { reason: 'Appeal accepted' } },
        ]);
        expect(await screen.findByRole('button', { name: 'Suspend engine' })).toBeTruthy();
    });

    it('offers nothing to lift for an engine its owner revoked', async () => {
        renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => api.on(apiRoutes.adminGetEngine, ok({ engine: REVOKED })),
        });
        expect(await screen.findByText('Revoked by its owner')).toBeTruthy();
        expect(screen.getByText(/A revocation is permanent and cannot be lifted here/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Lift suspension' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Suspend engine' })).toBeNull();
    });

    it('explains an owner revocation that raced the form', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => {
                api.on(apiRoutes.adminGetEngine, ok({ engine: SUSPENDED }));
                api.on(apiRoutes.adminUnsuspendEngine, problem(409, 'owner-revoked'));
            },
        });
        await app.user.type(await screen.findByRole('textbox', { name: /Reason/ }), 'Appeal accepted');
        await app.user.click(screen.getByRole('button', { name: 'Lift suspension' }));
        expect(await screen.findByText(/Its owner revoked this engine/)).toBeTruthy();
    });

    it('says when no engine has the ID', async () => {
        renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => api.on(apiRoutes.adminGetEngine, problem(404, 'not-found')),
        });
        expect(await screen.findByText('No engine has this ID.')).toBeTruthy();
    });

    it('offers a retry when the engine cannot be loaded', async () => {
        const app = renderApp({
            path: PATH,
            session: ADMIN,
            script: (api) => api.on(apiRoutes.adminGetEngine, { kind: 'invalid-response', status: 200 }),
        });
        expect(await screen.findByText('The engine could not be loaded.')).toBeTruthy();
        app.api.on(apiRoutes.adminGetEngine, ok({ engine: adminEngineView() }));
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Active')).toBeTruthy();
    });

    it('does not exist for anyone else, and asks the API for nothing', async () => {
        const app = renderApp({ path: PATH, session: session() });
        expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.adminGetEngine)).toHaveLength(0);
    });
});
