import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { AUTHENTICATION_OPTIONS, passkey, session, sessionSummary } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';

function signInScript(api: ScriptedApi) {
    api.on(apiRoutes.signinOptions, ok({ options: AUTHENTICATION_OPTIONS }));
    api.on(apiRoutes.signinVerify, ok(session()));
    api.on(apiRoutes.listPasskeys, ok({ passkeys: [passkey()] }));
    api.on(apiRoutes.listSessions, ok({ sessions: [sessionSummary()] }));
}

describe('sign-in', () => {
    it.each(['/signin', '/signup', '/engines'])(
        'takes the 401 from GET /api/session on %s as signed out, logging nothing',
        async (path) => {
            const logged = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
            try {
                const app = renderApp({ path, script: signInScript });
                expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
                expect(app.api.callsTo(apiRoutes.getSession).length).toBeGreaterThan(0);
                expect(screen.queryByText('Something went wrong')).toBeNull();
                for (const spy of logged) {
                    expect(spy).not.toHaveBeenCalled();
                }
            } finally {
                for (const spy of logged) {
                    spy.mockRestore();
                }
            }
        },
    );

    it('sends a signed-out visit to /account to sign-in and back after the passkey', async () => {
        const app = renderApp({ path: '/account', script: signInScript });
        expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/signin');
        expect(app.history.location.search).toBe('?returnTo=%2Faccount');
        await expectNoAxeViolations(app.container);

        app.api.on(apiRoutes.getSession, ok(session()));
        await app.user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
        expect(await screen.findByRole('heading', { name: 'Account', level: 1 })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/account');
        expect(app.passkeys.authenticate).toHaveBeenCalledWith(AUTHENTICATION_OPTIONS);
    });

    it('goes home without a returnTo', async () => {
        const app = renderApp({ path: '/signin', script: signInScript });
        await app.user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
        expect(await screen.findByRole('heading', { name: 'Engines' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/engines');
    });

    it.each(['%2F%2Fevil.example', '%2F%5Cevil.example', 'https%3A%2F%2Fevil.example%2F', '%2Fsignup'])(
        'ignores an unsafe returnTo (%s) and goes home',
        async (returnTo) => {
            const app = renderApp({ path: `/signin?returnTo=${returnTo}`, script: signInScript });
            await app.user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
            expect(await screen.findByRole('heading', { name: 'Engines' })).toBeTruthy();
            expect(app.history.location.pathname).toBe('/engines');
        },
    );

    it.each([
        ['cancelled', /found no Promptbook passkey on this device/],
        ['no-authenticator', /No passkey can be created on this device/],
        ['not-allowed', /not allowed to use passkeys/],
        ['unsupported', /does not support passkeys/],
    ] as const)('explains a %s ceremony and retries with the same button', async (reason, message) => {
        const app = renderApp({ path: '/signin', script: signInScript });
        app.passkeys.failNext(reason);
        await app.user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
        expect(await screen.findByText(message)).toBeTruthy();
        await expectNoAxeViolations(app.container);
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('heading', { name: 'Engines' })).toBeTruthy();
    });

    it.each([
        ['challenge-invalid', /request expired/],
        ['webauthn-failed', /not registered with Promptbook/],
    ])('explains a refused %s verification', async (code, message) => {
        const app = renderApp({
            path: '/signin',
            script: (api) => {
                signInScript(api);
                api.once(apiRoutes.signinVerify, problem(401, code));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Sign in with a passkey' }));
        expect(await screen.findByText(message)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    });

    it('sends someone already signed in from /signin and /signup home', async () => {
        const first = renderApp({ path: '/signin', session: session() });
        expect(await screen.findByRole('heading', { name: 'Engines' })).toBeTruthy();
        expect(first.history.location.pathname).toBe('/engines');
        first.unmount();
        const second = renderApp({ path: '/signup', session: session() });
        expect(await screen.findByRole('heading', { name: 'Engines' })).toBeTruthy();
        await waitFor(() => {
            expect(second.history.location.pathname).toBe('/engines');
        });
    });

    it('links to sign-up and recovery', async () => {
        const app = renderApp({ path: '/signin' });
        await app.user.click(await screen.findByRole('link', { name: 'Create an account' }));
        expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
        await app.user.click(screen.getByRole('link', { name: 'Sign in' }));
        await app.user.click(await screen.findByRole('link', { name: 'Recover access' }));
        expect(await screen.findByRole('heading', { name: 'Recover access' })).toBeTruthy();
    });
});
