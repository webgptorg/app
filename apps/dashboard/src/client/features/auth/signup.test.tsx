import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { NOW, REGISTRATION_OPTIONS, REGISTRATION_RESPONSE, session, TOKEN } from '../../testing/fixtures';
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
        expect(await screen.findByRole('heading', { name: 'Check your email', level: 1 })).toBe(document.activeElement);
        expect(screen.queryByRole('heading', { name: 'Create your account' })).toBeNull();
        expect(screen.getByRole('status').textContent).toBe(
            'We sent a link to ada@example.test. Open it on this device to continue. It works once and expires in 15 minutes.',
        );
        expect(app.container.querySelector('strong')?.textContent).toBe('ada@example.test');
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

async function sendLink(app: ReturnType<typeof renderApp>): Promise<void> {
    await app.user.type(await screen.findByRole('textbox', { name: /Email/ }), 'ada@example.test');
    await app.user.click(screen.getByRole('button', { name: 'Send the link' }));
    await screen.findByRole('heading', { name: 'Check your email' });
}

describe('sign-up, sending the link again', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('offers the same address again only after a minute, then waits another minute', async () => {
        const fakeTimers = useFakeClock();
        const app = renderApp({ path: '/signup', script: signupScript, fakeTimers });
        await sendLink(app);
        const waiting = screen.getByRole<HTMLButtonElement>('button', { name: 'Send it again in 60 s' });
        expect(waiting.disabled).toBe(true);
        await elapse(59_000);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send it again in 1 s' }).disabled).toBe(true);
        await elapse(1000);
        await app.user.click(screen.getByRole('button', { name: 'Send it again' }));
        expect(await screen.findByText('Sent again.')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.signupStart)).toEqual([
            { body: { email: 'ada@example.test' } },
            { body: { email: 'ada@example.test' } },
        ]);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send it again in 60 s' }).disabled).toBe(true);
        await expectNoAxeViolations(app.container);
    });

    it('says when the resend was refused and stays on the sent screen', async () => {
        const fakeTimers = useFakeClock();
        const app = renderApp({ path: '/signup', script: signupScript, fakeTimers });
        await sendLink(app);
        app.api.on(apiRoutes.signupStart, problem(429, 'rate-limited'));
        await elapse(60_000);
        await app.user.click(screen.getByRole('button', { name: 'Send it again' }));
        expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
        expect(screen.queryByText('Sent again.')).toBeNull();
        expect(screen.getByRole('heading', { name: 'Check your email' })).toBeTruthy();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send it again' }).disabled).toBe(false);
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
        expect(await screen.findByRole('heading', { name: 'Engines' })).toBeTruthy();
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
        expect(await screen.findByRole('heading', { name: 'Enginy' })).toBeTruthy();
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
        expect(await screen.findByRole('heading', { name: 'Engines' })).toBeTruthy();
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
