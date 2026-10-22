import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { REGISTRATION_OPTIONS, REGISTRATION_RESPONSE, session, TOKEN } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';

function signupScript(api: ScriptedApi) {
    api.on(apiRoutes.signupStart, ok({ accepted: true as const }));
    api.on(apiRoutes.signupOptions, ok({ options: REGISTRATION_OPTIONS }));
    api.on(apiRoutes.signupVerify, ok(session()));
}

describe('sign-up, email step', () => {
    it('refuses an empty or malformed address before asking the server', async () => {
        const app = renderApp({ path: '/signup', script: signupScript });
        await app.user.click(await screen.findByRole('button', { name: 'Send the link' }));
        expect(await screen.findByText('Enter your email address.')).toBeTruthy();
        await app.user.type(screen.getByRole('textbox', { name: /Email/ }), 'not-an-email');
        await app.user.click(screen.getByRole('button', { name: 'Send the link' }));
        expect(await screen.findByText('Enter an email address like name@example.com.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([]);
        await expectNoAxeViolations(app.container);
    });

    it('confirms with the same words for any address, and can start over', async () => {
        const app = renderApp({ path: '/signup', script: signupScript });
        await app.user.type(await screen.findByRole('textbox', { name: /Email/ }), '  ada@example.test ');
        await app.user.click(screen.getByRole('button', { name: 'Send the link' }));
        expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
        expect(screen.getByText(/We sent a message to ada@example.test\./)).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([{ body: { email: 'ada@example.test' } }]);
        await expectNoAxeViolations(app.container);

        await app.user.click(screen.getByRole('button', { name: 'Use a different email' }));
        expect(screen.getByRole<HTMLInputElement>('textbox', { name: /Email/ }).value).toBe('');
    });

    it.each([
        ['rate-limited', problem(429, 'rate-limited'), /Too many attempts/],
        ['unreachable', { kind: 'network-error' } as const, /could not be reached/],
    ])('shows a %s failure and keeps the form', async (_label, outcome, message) => {
        const app = renderApp({ path: '/signup', script: (api) => api.on(apiRoutes.signupStart, outcome) });
        await app.user.type(await screen.findByRole('textbox', { name: /Email/ }), 'ada@example.test');
        await app.user.click(screen.getByRole('button', { name: 'Send the link' }));
        expect(await screen.findByText(message)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Send the link' })).toBeTruthy();
    });
});

describe('sign-up, passkey step', () => {
    it('takes the token out of the address before rendering, then creates the account and lands home', async () => {
        const app = renderApp({ path: `/signup#${TOKEN}`, script: signupScript });
        expect(await screen.findByRole('heading', { name: 'Create your passkey' })).toBeTruthy();
        expect(app.history.location.hash).toBe('');
        expect(app.history.location.href).toBe('/signup');
        await expectNoAxeViolations(app.container);

        app.api.on(apiRoutes.getSession, ok(session()));
        await app.user.click(screen.getByRole('button', { name: 'Create passkey' }));
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/engines');
        expect(app.api.callsTo(apiRoutes.signupOptions)).toEqual([{ body: { token: TOKEN } }]);
        expect(app.api.callsTo(apiRoutes.signupVerify)).toEqual([
            { body: { token: TOKEN, response: REGISTRATION_RESPONSE } },
        ]);
    });

    it('applies the account’s saved language after sign-up', async () => {
        const app = renderApp({
            path: `/signup#${TOKEN}`,
            script: (api) => {
                signupScript(api);
                api.on(apiRoutes.signupVerify, ok(session({ locale: 'cs' })));
            },
        });
        app.api.on(apiRoutes.getSession, ok(session({ locale: 'cs' })));
        await app.user.click(await screen.findByRole('button', { name: 'Create passkey' }));
        expect(await screen.findByRole('heading', { name: 'Vaše enginy' })).toBeTruthy();
        expect(document.documentElement.lang).toBe('cs');
        expect(document.cookie).toContain('ptbk_locale=cs');
    });

    it.each([
        ['cancelled', /prompt was closed or timed out/],
        ['no-authenticator', /No passkey can be created on this device/],
        ['already-registered', /already holds a passkey/],
    ] as const)('explains a %s registration and retries', async (reason, message) => {
        const app = renderApp({ path: `/signup#${TOKEN}`, script: signupScript });
        app.passkeys.failNext(reason);
        await app.user.click(await screen.findByRole('button', { name: 'Create passkey' }));
        expect(await screen.findByText(message)).toBeTruthy();
        app.api.on(apiRoutes.getSession, ok(session()));
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('heading', { name: 'Your engines' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.signupOptions)).toHaveLength(2);
    });

    it('explains an expired link and offers a new one', async () => {
        const app = renderApp({
            path: `/signup#${TOKEN}`,
            script: (api) => {
                signupScript(api);
                api.on(apiRoutes.signupOptions, problem(400, 'token-invalid'));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Create passkey' }));
        expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Get a new link' }));
        expect(await screen.findByRole('textbox', { name: /Email/ })).toBeTruthy();
    });

    it('refuses a malformed fragment and still removes it', async () => {
        const app = renderApp({ path: '/signup#nope', script: signupScript });
        expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeTruthy();
        expect(app.history.location.hash).toBe('');
        expect(app.api.callsTo(apiRoutes.signupOptions)).toEqual([]);
        await app.user.click(screen.getByRole('button', { name: 'Get a new link' }));
        expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
    });

    it('picks up a link opened in the tab that already shows the page', async () => {
        const app = renderApp({ path: '/signup', script: signupScript });
        expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeTruthy();
        app.history.push(`/signup#${TOKEN}`);
        expect(await screen.findByRole('heading', { name: 'Create your passkey' })).toBeTruthy();
        await waitFor(() => {
            expect(app.history.location.hash).toBe('');
        });
    });
});
