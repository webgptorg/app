import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import {
    AUTHENTICATION_OPTIONS,
    NOW,
    passkey,
    REGISTRATION_OPTIONS,
    session,
    sessionSummary,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';

const SECOND = passkey({
    credentialId: 'c2Vjb25kLXBhc3NrZXktYWJjZA',
    addedVia: 'account',
    backedUp: false,
    lastUsedAt: null,
    provider: null,
    counterRegressedAt: NOW - 1000,
});

function accountScript(passkeys = [passkey()]) {
    return (api: ScriptedApi) => {
        api.on(apiRoutes.listPasskeys, ok({ passkeys }));
        api.on(
            apiRoutes.listSessions,
            ok({ sessions: [sessionSummary(), sessionSummary({ current: false, createdAt: NOW - 86_400_000 })] }),
        );
        api.on(apiRoutes.passkeyOptions, ok({ options: REGISTRATION_OPTIONS }));
        api.on(apiRoutes.passkeyVerify, ok({ passkey: SECOND }));
        api.on(apiRoutes.passkeyDelete, ok({}));
        api.on(apiRoutes.revokeAllSessions, ok({}));
        api.on(apiRoutes.stepUpOptions, ok({ options: AUTHENTICATION_OPTIONS }));
        api.on(apiRoutes.stepUpVerify, ok({ steppedUpUntil: NOW + 300_000 }));
    };
}

function passkeyTable() {
    return screen.getByRole('table', { name: 'Passkeys' });
}

function notifications() {
    return within(screen.getByRole('region', { name: 'Notifications' }));
}

describe('account page', () => {
    it('lists the email, passkeys and sessions, and keeps the only passkey', async () => {
        const app = renderApp({ path: '/account', session: session(), script: accountScript() });
        expect(await screen.findByRole('heading', { name: 'Account', level: 1 })).toBeTruthy();
        expect(screen.getAllByText('ada@example.test').length).toBeGreaterThan(0);
        expect(await within(passkeyTable()).findByText('At sign-up')).toBeTruthy();
        expect(within(passkeyTable()).getByText('Synced across devices')).toBeTruthy();
        const sessions = await screen.findByRole('table', { name: 'Sessions' });
        expect(within(sessions).getByText('This browser')).toBeTruthy();
        expect(within(sessions).getByText('Another browser')).toBeTruthy();
        expect(screen.queryByText('Your account was recently recovered')).toBeNull();

        expect(within(passkeyTable()).getByText('Google Password Manager')).toBeTruthy();
        expect(within(passkeyTable()).getByText(/^Created /)).toBeTruthy();
        expect(within(passkeyTable()).getByText(/Last used/)).toBeTruthy();
        const remove = within(passkeyTable()).getByRole('button', {
            name: /^Remove Google Password Manager \(created .+\)$/,
        });
        expect(remove.getAttribute('aria-disabled')).toBe('true');
        await app.user.click(remove);
        expect(screen.queryByRole('dialog', { name: 'Remove this passkey?' })).toBeNull();
        await expectNoAxeViolations(app.container);
    });

    it('adds a passkey, reports it and reloads the list', async () => {
        const app = renderApp({ path: '/account', session: session(), script: accountScript() });
        await within(await screen.findByRole('table', { name: 'Passkeys' })).findByText('At sign-up');
        app.api.on(apiRoutes.listPasskeys, ok({ passkeys: [passkey(), SECOND] }));
        await app.user.click(screen.getByRole('button', { name: 'Add a passkey' }));
        expect(await notifications().findByText('Passkey added')).toBeTruthy();
        expect(await within(passkeyTable()).findByText('From your account')).toBeTruthy();
        expect(within(passkeyTable()).getByText('On one device')).toBeTruthy();
        // The column header and the passkey whose provider is unknown.
        expect(within(passkeyTable()).getAllByText('Passkey')).toHaveLength(2);
        expect(within(passkeyTable()).getByText(/Never used/)).toBeTruthy();
        expect(within(passkeyTable()).getByText('Possible copy, check it')).toBeTruthy();
    });

    it('reports a passkey the authenticator already holds', async () => {
        const app = renderApp({ path: '/account', session: session(), script: accountScript() });
        await within(await screen.findByRole('table', { name: 'Passkeys' })).findByText('At sign-up');
        app.passkeys.failNext('already-registered');
        await app.user.click(screen.getByRole('button', { name: 'Add a passkey' }));
        expect(await notifications().findByText(/already holds a passkey/)).toBeTruthy();
    });

    it('removes a passkey after confirmation', async () => {
        const app = renderApp({ path: '/account', session: session(), script: accountScript([passkey(), SECOND]) });
        const table = await screen.findByRole('table', { name: 'Passkeys' });
        const row = (await within(table).findByText('At sign-up')).closest('tr');
        if (row === null) throw new Error('no row');
        await app.user.click(within(row).getByRole('button', { name: /^Remove / }));
        const dialog = await screen.findByRole('dialog', { name: 'Remove this passkey?' });
        app.api.on(apiRoutes.listPasskeys, ok({ passkeys: [SECOND] }));
        await app.user.click(within(dialog).getByRole('button', { name: 'Remove' }));
        expect(await notifications().findByText('Passkey removed')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.passkeyDelete)).toEqual([{ body: { credentialId: passkey().credentialId } }]);
        await waitFor(() => {
            expect(within(passkeyTable()).queryByText('At sign-up')).toBeNull();
        });
    });

    it('cancels a removal from the dialog', async () => {
        const app = renderApp({ path: '/account', session: session(), script: accountScript([passkey(), SECOND]) });
        const table = await screen.findByRole('table', { name: 'Passkeys' });
        await within(table).findByText('At sign-up');
        await app.user.click(within(table).getAllByRole('button', { name: /^Remove / })[0] as HTMLElement);
        const dialog = await screen.findByRole('dialog', { name: 'Remove this passkey?' });
        await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(app.api.callsTo(apiRoutes.passkeyDelete)).toEqual([]);
    });

    it('explains that the last passkey cannot go', async () => {
        const app = renderApp({
            path: '/account',
            session: session(),
            script: (api) => {
                accountScript([passkey(), SECOND])(api);
                api.on(apiRoutes.passkeyDelete, problem(409, 'last-passkey'));
            },
        });
        const table = await screen.findByRole('table', { name: 'Passkeys' });
        await within(table).findByText('At sign-up');
        await app.user.click(within(table).getAllByRole('button', { name: /^Remove / })[0] as HTMLElement);
        await app.user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));
        expect(await notifications().findByText(/only passkey cannot be removed/)).toBeTruthy();
    });

    it('signs out everywhere after confirmation and goes to sign-in', async () => {
        const app = renderApp({ path: '/account', session: session(), script: accountScript() });
        await screen.findByRole('table', { name: 'Sessions' });
        const signOutEverywhere = screen.getByRole('button', { name: 'Sign out everywhere' });
        // A rare, disruptive action stays quieter than "Add a passkey"; only its confirmation is a filled red button.
        expect(signOutEverywhere.className).toContain('danger-ghost');
        await app.user.click(signOutEverywhere);
        const dialog = await screen.findByRole('dialog', { name: 'Sign out everywhere?' });
        await app.user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
        expect(await screen.findByRole('heading', { name: 'Sign in or create an account' })).toBeTruthy();
        expect(app.history.location.pathname).toBe('/continue');
        expect(app.api.callsTo(apiRoutes.revokeAllSessions)).toHaveLength(1);
    });

    it('keeps the session when "sign out everywhere" is cancelled', async () => {
        const app = renderApp({ path: '/account', session: session(), script: accountScript() });
        await screen.findByRole('table', { name: 'Sessions' });
        await app.user.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
        const dialog = await screen.findByRole('dialog', { name: 'Sign out everywhere?' });
        await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(app.history.location.pathname).toBe('/account');
        expect(app.api.callsTo(apiRoutes.revokeAllSessions)).toHaveLength(0);
    });

    it('shows load errors in each table with a retry', async () => {
        const app = renderApp({
            path: '/account',
            session: session(),
            script: (api) => {
                api.on(apiRoutes.listPasskeys, problem(500, 'internal'));
                api.on(apiRoutes.listSessions, problem(500, 'internal'));
            },
        });
        expect(await screen.findByText('Your passkeys could not be loaded.', {}, { timeout: 5000 })).toBeTruthy();
        expect(await screen.findByText('Your sessions could not be loaded.', {}, { timeout: 5000 })).toBeTruthy();
        app.api.on(apiRoutes.listPasskeys, ok({ passkeys: [passkey()] }));
        app.api.on(apiRoutes.listSessions, ok({ sessions: [sessionSummary()] }));
        for (const retry of screen.getAllByRole('button', { name: 'Try again' })) {
            await app.user.click(retry);
        }
        expect(await screen.findByText('At sign-up')).toBeTruthy();
        expect(await screen.findByText('This browser')).toBeTruthy();
    });

    it('shows the recovery cooldown until it ends', async () => {
        renderApp({
            path: '/account',
            session: session({ recoveryCooldownEndsAt: NOW + 1000 }),
            script: accountScript(),
        });
        expect(await screen.findByText('Your account was recently recovered')).toBeTruthy();
    });
});

describe('step-up and refusals', () => {
    it('asks for a passkey when the API wants a step-up, then retries the action', async () => {
        const app = renderApp({
            path: '/account',
            session: session(),
            script: (api) => {
                accountScript([passkey(), SECOND])(api);
                api.once(apiRoutes.passkeyDelete, problem(403, 'step-up-required'));
            },
        });
        const table = await screen.findByRole('table', { name: 'Passkeys' });
        await within(table).findByText('At sign-up');
        await app.user.click(within(table).getAllByRole('button', { name: /^Remove / })[0] as HTMLElement);
        await app.user.click(
            within(await screen.findByRole('dialog', { name: 'Remove this passkey?' })).getByRole('button', {
                name: 'Remove',
            }),
        );

        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await expectNoAxeViolations(stepUp);
        app.passkeys.failNext('cancelled');
        await app.user.click(within(stepUp).getByRole('button', { name: 'Use passkey' }));
        expect(await within(stepUp).findByText(/found no Promptbook passkey/)).toBeTruthy();
        await app.user.click(within(stepUp).getByRole('button', { name: 'Try again' }));

        expect(await notifications().findByText('Passkey removed')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.stepUpVerify)).toHaveLength(1);
        expect(app.api.callsTo(apiRoutes.passkeyDelete)).toHaveLength(2);
    });

    it('steps up and retries when adding a passkey needs it', async () => {
        const app = renderApp({
            path: '/account',
            session: session(),
            script: (api) => {
                accountScript()(api);
                api.once(apiRoutes.passkeyOptions, problem(403, 'step-up-required'));
            },
        });
        await screen.findByRole('table', { name: 'Passkeys' });
        await app.user.click(screen.getByRole('button', { name: 'Add a passkey' }));
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await app.user.click(within(stepUp).getByRole('button', { name: 'Use passkey' }));
        expect(await notifications().findByText('Passkey added')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.passkeyOptions)).toHaveLength(2);
    });

    it.each([
        ['challenge-invalid', /request expired/],
        ['conflict', /already registered/],
        ['rate-limited', /Too many attempts/],
    ] as const)('explains a %s answer to adding a passkey', async (code, message) => {
        const app = renderApp({
            path: '/account',
            session: session(),
            script: (api) => {
                accountScript()(api);
                api.on(apiRoutes.passkeyVerify, problem(code === 'rate-limited' ? 429 : 400, code));
            },
        });
        await screen.findByRole('table', { name: 'Passkeys' });
        await app.user.click(screen.getByRole('button', { name: 'Add a passkey' }));
        expect(await notifications().findByText(message)).toBeTruthy();
    });

    it('reports a cancelled step-up without retrying', async () => {
        const app = renderApp({
            path: '/account',
            session: session(),
            script: (api) => {
                accountScript([passkey(), SECOND])(api);
                api.on(apiRoutes.passkeyDelete, problem(403, 'step-up-required'));
            },
        });
        const table = await screen.findByRole('table', { name: 'Passkeys' });
        await within(table).findByText('At sign-up');
        await app.user.click(within(table).getAllByRole('button', { name: /^Remove / })[0] as HTMLElement);
        await app.user.click(
            within(await screen.findByRole('dialog', { name: 'Remove this passkey?' })).getByRole('button', {
                name: 'Remove',
            }),
        );
        const stepUp = await screen.findByRole('dialog', { name: 'Confirm it is you' });
        await app.user.click(within(stepUp).getByRole('button', { name: 'Cancel' }));
        expect(
            await notifications().findByText('Not done: this action needs a fresh check with your passkey.'),
        ).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.passkeyDelete)).toHaveLength(1);
    });

    it.each([
        [
            'recovery-cooldown with an end',
            session({ recoveryCooldownEndsAt: NOW + 3_600_000 }),
            problem(403, 'recovery-cooldown'),
            /^Blocked until .+: your account was recently recovered\.$/,
        ],
        ['recovery-cooldown without one', session(), problem(403, 'recovery-cooldown'), /Blocked for 72 hours/],
        ['forbidden', session(), problem(403, 'forbidden'), /not allowed to do that/],
        ['rate-limited', session(), problem(429, 'rate-limited'), /Too many attempts/],
        ['a network error', session(), { kind: 'network-error' } as const, /could not be reached/],
        ['anything else', session(), problem(500, 'internal'), /That did not work/],
    ])('reports %s in a toast', async (_label, signedIn, outcome, message) => {
        const app = renderApp({
            path: '/account',
            session: signedIn,
            script: (api) => {
                accountScript([passkey(), SECOND])(api);
                api.on(apiRoutes.passkeyDelete, outcome);
            },
        });
        const table = await screen.findByRole('table', { name: 'Passkeys' });
        await within(table).findByText('At sign-up');
        await app.user.click(within(table).getAllByRole('button', { name: /^Remove / })[0] as HTMLElement);
        await app.user.click(
            within(await screen.findByRole('dialog', { name: 'Remove this passkey?' })).getByRole('button', {
                name: 'Remove',
            }),
        );
        expect(await notifications().findByText(message)).toBeTruthy();
    });

    it('sends a session that ended elsewhere to sign-in, coming back afterwards', async () => {
        const app = renderApp({
            path: '/account',
            session: session(),
            script: (api) => {
                accountScript()(api);
                api.on(apiRoutes.listPasskeys, problem(401, 'unauthorized'));
            },
        });
        expect(await screen.findByRole('heading', { name: 'Sign in or create an account' })).toBeTruthy();
        expect(app.history.location.search).toBe('?returnTo=%2Faccount');
    });
});
