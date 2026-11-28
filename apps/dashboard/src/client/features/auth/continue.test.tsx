import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import {
    AUTHENTICATION_OPTIONS,
    AUTHENTICATION_RESPONSE,
    NOW,
    passkey,
    session,
    sessionSummary,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import type { RenderedApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';

function continueScript(api: ScriptedApi) {
    api.on(apiRoutes.signinOptions, ok({ options: AUTHENTICATION_OPTIONS }));
    api.on(apiRoutes.signinVerify, ok(session()));
    api.on(apiRoutes.signupStart, ok({ accepted: true as const }));
    api.on(apiRoutes.listPasskeys, ok({ passkeys: [passkey()] }));
    api.on(apiRoutes.listSessions, ok({ sessions: [sessionSummary()] }));
}

async function continueWith(app: RenderedApp, email = 'ada@example.test'): Promise<void> {
    await app.user.type(await screen.findByRole('textbox', { name: /Email/ }), email);
    await app.user.click(screen.getByRole('button', { name: 'Continue' }));
}

async function openPasskeyPicker(app: RenderedApp): Promise<void> {
    await app.user.click(await screen.findByRole('button', { name: 'Use a passkey' }));
}

describe('Continue', () => {
    it.each(['/continue', '/signin', '/signup', '/engines'])(
        'takes the 401 from GET /api/session on %s as signed out, logging nothing',
        async (path) => {
            const logged = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
            try {
                const app = renderApp({ path, script: continueScript });
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

    it('asks for the email once, says the browser offers a passkey it has, and offers the field to the autofill', async () => {
        const app = renderApp({ path: '/continue', script: continueScript });
        expect(await screen.findByRole('heading', { name: 'Sign in or create an account', level: 1 })).toBeTruthy();
        expect(
            screen.getByText('Already have a passkey on this device? Your browser offers it in the email field.'),
        ).toBeTruthy();
        expect(screen.getByRole('textbox', { name: /Email/ }).getAttribute('autocomplete')).toBe('username webauthn');
        expect(screen.getAllByRole('button').filter((button) => button.textContent === 'Continue')).toHaveLength(1);
        expect(screen.getByRole('button', { name: 'Use a passkey' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });

    it('sends the email on Continue without opening a passkey picker, in the same words for any address', async () => {
        const app = renderApp({ path: '/continue', script: continueScript });
        await continueWith(app, '  ada@example.test ');
        expect(await screen.findByRole('heading', { name: 'Check your email', level: 1 })).toBe(document.activeElement);
        expect(screen.getByRole('status').textContent).toBe(
            'We sent an email to ada@example.test. Open it on this device and follow its link: it helps you sign in, or finishes creating your account.',
        );
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([{ body: { email: 'ada@example.test' } }]);
        expect(app.passkeys.authenticate).not.toHaveBeenCalled();
        expect(app.api.callsTo(apiRoutes.signinOptions)).toEqual([]);
        expect(screen.queryByRole('button', { name: /passkey/ })).toBeNull();
        await expectNoAxeViolations(app.container);
    });

    it('refuses an empty or malformed address before trying anything', async () => {
        const app = renderApp({ path: '/continue', script: continueScript });
        await app.user.click(await screen.findByRole('button', { name: 'Continue' }));
        expect(await screen.findByText('Enter your email address.')).toBeTruthy();
        await app.user.type(screen.getByRole('textbox', { name: /Email/ }), 'not-an-email');
        await app.user.click(screen.getByRole('button', { name: 'Continue' }));
        expect(await screen.findByText('Enter an email address like name@example.com.')).toBeTruthy();
        expect(app.passkeys.authenticate).not.toHaveBeenCalled();
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([]);
    });

    it.each([
        ['rate-limited', problem(429, 'rate-limited'), /Too many attempts/],
        ['unreachable', { kind: 'network-error' } as const, /could not be reached/],
    ])('shows a %s failure of the email and keeps the form', async (_label, outcome, message) => {
        const app = renderApp({
            path: '/continue',
            script: (api) => {
                continueScript(api);
                api.on(apiRoutes.signupStart, outcome);
            },
        });
        await continueWith(app);
        expect(await screen.findByText(message)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    });

    it('can start over with another address', async () => {
        const app = renderApp({ path: '/continue', script: continueScript });
        await continueWith(app);
        await app.user.click(await screen.findByRole('button', { name: 'Use a different email' }));
        expect(screen.getByRole<HTMLInputElement>('textbox', { name: /Email/ }).value).toBe('');
    });

    it('links to recovery', async () => {
        const app = renderApp({ path: '/continue' });
        await app.user.click(await screen.findByRole('link', { name: 'Recover by email' }));
        expect(await screen.findByRole('heading', { name: 'Recover access' })).toBeTruthy();
        await app.user.click(screen.getByRole('link', { name: 'Sign in' }));
        expect(await screen.findByRole('heading', { name: 'Sign in or create an account' })).toBeTruthy();
    });
});

describe('Continue, "Use a passkey"', () => {
    it('opens the picker on purpose and signs in, sending no email', async () => {
        const app = renderApp({ path: '/continue', script: continueScript });
        app.api.on(apiRoutes.getSession, ok(session()));
        await openPasskeyPicker(app);
        expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
        expect(app.passkeys.authenticate).toHaveBeenCalledWith(AUTHENTICATION_OPTIONS, expect.any(AbortSignal));
        expect(app.api.callsTo(apiRoutes.signinVerify)).toEqual([{ body: { response: AUTHENTICATION_RESPONSE } }]);
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([]);
    });

    it('ignores an autofill answer that arrives after the explicit picker has opened', async () => {
        const autofill = Promise.withResolvers<{ kind: 'ok'; response: typeof AUTHENTICATION_RESPONSE }>();
        const app = renderApp({
            path: '/continue',
            script: continueScript,
            passkeys: (passkeys) => {
                passkeys.supportsAutofill.mockResolvedValue(true);
                passkeys.autofill.mockReturnValueOnce(autofill.promise);
                passkeys.authenticate.mockReturnValueOnce(new Promise(() => undefined));
            },
        });
        await waitFor(() => {
            expect(app.passkeys.autofill).toHaveBeenCalledOnce();
        });
        await openPasskeyPicker(app);
        expect(await screen.findByRole('button', { name: 'Reopen passkey prompt' })).toBeTruthy();
        autofill.resolve({ kind: 'ok', response: AUTHENTICATION_RESPONSE });
        await autofill.promise;
        await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
        });
        expect(app.api.callsTo(apiRoutes.signinVerify)).toHaveLength(0);
    });

    it('reopens a lost picker with fresh options and verifies only the current answer', async () => {
        const old = Promise.withResolvers<{ kind: 'ok'; response: typeof AUTHENTICATION_RESPONSE }>();
        const app = renderApp({ path: '/continue', script: continueScript });
        app.passkeys.authenticate.mockReturnValueOnce(old.promise);
        await openPasskeyPicker(app);
        const fresh = { ...AUTHENTICATION_OPTIONS, challenge: 'ZnJlc2g' };
        app.api.on(apiRoutes.signinOptions, ok({ options: fresh }));
        app.api.on(apiRoutes.getSession, ok(session()));
        await app.user.click(await screen.findByRole('button', { name: 'Reopen passkey prompt' }));
        expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
        old.resolve({ kind: 'ok', response: AUTHENTICATION_RESPONSE });
        await old.promise;
        expect(app.passkeys.authenticate.mock.calls.map(([options]) => options)).toEqual([
            AUTHENTICATION_OPTIONS,
            fresh,
        ]);
        expect(app.api.callsTo(apiRoutes.signinVerify)).toEqual([{ body: { response: AUTHENTICATION_RESPONSE } }]);
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([]);
    });

    it('says why when the picker is closed or finds nothing, keeps the email path, and re-arms the autofill', async () => {
        const app = renderApp({
            path: '/continue',
            script: continueScript,
            passkeys: (passkeys) => {
                passkeys.supportsAutofill.mockResolvedValue(true);
            },
        });
        await waitFor(() => {
            expect(app.passkeys.autofill).toHaveBeenCalledTimes(1);
        });
        app.passkeys.failNext('cancelled');
        await openPasskeyPicker(app);
        expect(await screen.findByText(/found no Promptbook passkey on this device/)).toBeTruthy();
        await waitFor(() => {
            expect(app.passkeys.autofill).toHaveBeenCalledTimes(2);
        });
        await continueWith(app);
        expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([{ body: { email: 'ada@example.test' } }]);
    });

    it('drops the failure once the email is sent, so another address starts clean', async () => {
        const app = renderApp({ path: '/continue', script: continueScript });
        app.passkeys.failNext('cancelled');
        await openPasskeyPicker(app);
        expect(await screen.findByText(/found no Promptbook passkey on this device/)).toBeTruthy();
        await continueWith(app);
        await app.user.click(await screen.findByRole('button', { name: 'Use a different email' }));
        expect(await screen.findByRole('textbox', { name: /Email/ })).toBeTruthy();
        expect(screen.queryByText(/found no Promptbook passkey on this device/)).toBeNull();
    });

    it('explains a passkey the server refused, and lets the person try again', async () => {
        const app = renderApp({
            path: '/continue',
            script: (api) => {
                continueScript(api);
                api.once(apiRoutes.signinVerify, problem(401, 'webauthn-failed'));
            },
        });
        await openPasskeyPicker(app);
        expect(await screen.findByText(/not registered with Promptbook/)).toBeTruthy();
        app.api.on(apiRoutes.getSession, ok(session()));
        await openPasskeyPicker(app);
        expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([]);
    });
});

describe('Continue, passkey autofill', () => {
    it('signs in when the person picks a passkey from the email field', async () => {
        const app = renderApp({
            path: '/continue',
            script: continueScript,
            passkeys: (passkeys) => {
                passkeys.supportsAutofill.mockResolvedValue(true);
                passkeys.autofill.mockResolvedValue({ kind: 'ok', response: AUTHENTICATION_RESPONSE });
            },
        });
        app.api.on(apiRoutes.getSession, ok(session()));
        expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
        expect(app.passkeys.autofill).toHaveBeenCalledWith(AUTHENTICATION_OPTIONS, expect.any(AbortSignal));
        expect(app.passkeys.authenticate).not.toHaveBeenCalled();
    });

    it('stays quiet when aborted, and re-arms after an expired challenge', async () => {
        const app = renderApp({
            path: '/continue',
            script: (api) => {
                continueScript(api);
                api.once(apiRoutes.signinVerify, problem(400, 'challenge-invalid'));
            },
            passkeys: (passkeys) => {
                passkeys.supportsAutofill.mockResolvedValue(true);
                passkeys.autofill
                    .mockResolvedValueOnce({ kind: 'ok', response: AUTHENTICATION_RESPONSE })
                    .mockResolvedValueOnce({ kind: 'failed', reason: 'cancelled' });
            },
        });
        await screen.findByRole('heading', { name: 'Sign in or create an account' });
        await waitFor(() => {
            expect(app.passkeys.autofill).toHaveBeenCalledTimes(2);
        });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByText(/request expired/)).toBeNull();
    });

    it('explains a passkey the server refused', async () => {
        renderApp({
            path: '/continue',
            script: (api) => {
                continueScript(api);
                api.on(apiRoutes.signinVerify, problem(401, 'webauthn-failed'));
            },
            passkeys: (passkeys) => {
                passkeys.supportsAutofill.mockResolvedValue(true);
                passkeys.autofill.mockResolvedValueOnce({ kind: 'ok', response: AUTHENTICATION_RESPONSE });
            },
        });
        expect(await screen.findByText(/not registered with Promptbook/)).toBeTruthy();
    });

    it('is not started where the browser cannot offer passkeys in autofill', async () => {
        const app = renderApp({ path: '/continue', script: continueScript });
        await screen.findByRole('heading', { name: 'Sign in or create an account' });
        await waitFor(() => {
            expect(app.passkeys.supportsAutofill).toHaveBeenCalled();
        });
        expect(app.passkeys.autofill).not.toHaveBeenCalled();
        expect(app.api.callsTo(apiRoutes.signinOptions)).toEqual([]);
    });
});

describe('Continue, returning afterwards', () => {
    it('sends a signed-out visit to /account through Continue and back after the passkey', async () => {
        const app = renderApp({ path: '/account', script: continueScript });
        expect(await screen.findByRole('heading', { name: 'Sign in or create an account' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/continue');
        expect(app.history.location.search).toBe('?returnTo=%2Faccount');
        app.api.on(apiRoutes.getSession, ok(session()));
        await openPasskeyPicker(app);
        expect(await screen.findByRole('heading', { name: 'Account', level: 1 })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/account');
    });

    it('keeps returnTo when the old /signin address redirects', async () => {
        const app = renderApp({ path: '/signin?returnTo=%2Faccount', script: continueScript });
        expect(await screen.findByRole('heading', { name: 'Sign in or create an account' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/continue');
        expect(app.history.location.search).toBe('?returnTo=%2Faccount');
    });

    it('sends the old /signup address without a link to Continue', async () => {
        const app = renderApp({ path: '/signup', script: continueScript });
        expect(await screen.findByRole('heading', { name: 'Sign in or create an account' })).toBeTruthy();
        await waitFor(() => {
            expect(app.history.location.pathname).toBe('/continue');
        });
    });

    it.each(['%2F%2Fevil.example', '%2F%5Cevil.example', 'https%3A%2F%2Fevil.example%2F', '%2Fsignup', '%2Fcontinue'])(
        'ignores an unsafe returnTo (%s) and goes home',
        async (returnTo) => {
            const app = renderApp({ path: `/continue?returnTo=${returnTo}`, script: continueScript });
            await openPasskeyPicker(app);
            expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
            expect(app.history.location.pathname).toBe('/engines');
        },
    );

    it('sends someone already signed in from /continue, /signin and /signup home', async () => {
        for (const path of ['/continue', '/signin', '/signup']) {
            const app = renderApp({ path, session: session() });
            expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy();
            await waitFor(() => {
                expect(app.history.location.pathname).toBe('/engines');
            });
            app.unmount();
        }
    });
});

function useFakeClock() {
    vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(NOW);
    return { advance: (ms: number) => vi.advanceTimersByTime(ms) };
}

async function elapse(ms: number): Promise<void> {
    await act(() => vi.advanceTimersByTimeAsync(ms));
}

describe('Continue, sending the email again', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('offers the same address again only after a minute, then waits another minute', async () => {
        const fakeTimers = useFakeClock();
        const app = renderApp({ path: '/continue', script: continueScript, fakeTimers });
        await continueWith(app);
        await screen.findByRole('heading', { name: 'Check your email' });
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send it again in 60 s' }).disabled).toBe(true);
        await elapse(60_000);
        await app.user.click(screen.getByRole('button', { name: 'Send it again' }));
        expect(await screen.findByText('Sent again.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.signupStart)).toHaveLength(2);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send it again in 60 s' }).disabled).toBe(true);
    });

    it('says when the resend was refused and stays on the sent screen', async () => {
        const fakeTimers = useFakeClock();
        const app = renderApp({ path: '/continue', script: continueScript, fakeTimers });
        await continueWith(app);
        await screen.findByRole('heading', { name: 'Check your email' });
        app.api.on(apiRoutes.signupStart, problem(429, 'rate-limited'));
        await elapse(60_000);
        await app.user.click(screen.getByRole('button', { name: 'Send it again' }));
        expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Check your email' })).toBeTruthy();
    });
});
