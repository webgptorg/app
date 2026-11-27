import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { NOW, passkey, REGISTRATION_OPTIONS, session, sessionSummary, TOKEN } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import type { ScriptedApi } from '../../testing/scripted-api';
import { ok, problem } from '../../testing/scripted-api';

const COOLDOWN_END = NOW + 72 * 3_600_000;
const recovered = session({ recoveryCooldownEndsAt: COOLDOWN_END });

function recoveryScript(api: ScriptedApi) {
    api.on(apiRoutes.recoveryRequest, ok({ accepted: true as const }));
    api.on(apiRoutes.recoveryOptions, ok({ options: REGISTRATION_OPTIONS }));
    api.on(apiRoutes.recoveryVerify, ok(recovered));
    api.on(
        apiRoutes.listPasskeys,
        ok({ passkeys: [passkey(), passkey({ credentialId: 'cmVjb3Zlcnkta2V5LXR3bw', addedVia: 'recovery' })] }),
    );
    api.on(apiRoutes.listSessions, ok({ sessions: [sessionSummary()] }));
}

describe('recovery', () => {
    it('asks for the email and confirms without saying whether the account exists', async () => {
        const app = renderApp({ path: '/recover', script: recoveryScript });
        expect(await screen.findByRole('heading', { name: 'Recover access' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
        await app.user.type(screen.getByRole('textbox', { name: /Email/ }), 'ada@example.test');
        await app.user.click(screen.getByRole('button', { name: 'Send a recovery link' }));
        expect(await screen.findByRole('heading', { name: 'Check your email', level: 1 })).toBeTruthy();
        expect(screen.getByRole('status').textContent).toMatch(/^If ada@example.test belongs to a Promptbook account/);
        expect(app.api.callsTo(apiRoutes.recoveryRequest)).toEqual([{ body: { email: 'ada@example.test' } }]);
        await expectNoAxeViolations(app.container);
    });

    it('registers a new passkey with the token, then shows the cooldown and leads to the account', async () => {
        const app = renderApp({ path: `/recover#${TOKEN}`, script: recoveryScript });
        expect(await screen.findByRole('heading', { name: 'Register a new passkey' })).toBeTruthy();
        expect(app.history.location.hash).toBe('');
        await expectNoAxeViolations(app.container);

        app.api.on(apiRoutes.getSession, ok(recovered));
        await app.user.click(screen.getByRole('button', { name: 'Register new passkey' }));
        expect(await screen.findByRole('heading', { name: 'Access recovered' })).toBeTruthy();
        expect(screen.getByText('Your account was recently recovered')).toBeTruthy();
        expect(app.api.callsTo(apiRoutes.recoveryVerify)).toHaveLength(1);
        await expectNoAxeViolations(app.container);

        await app.user.click(screen.getByRole('link', { name: 'Go to your account' }));
        expect(await screen.findByRole('heading', { name: 'Account', level: 1 })).toBeTruthy();
        expect(screen.getByText('Your account was recently recovered')).toBeTruthy();
        expect(await screen.findByText('By recovery')).toBeTruthy();
    });

    it('offers an invitation waiting for the address once a passkey is added', async () => {
        const app = renderApp({
            path: `/recover#${TOKEN}`,
            script: (api) => {
                recoveryScript(api);
                api.on(
                    apiRoutes.listInviteOffers,
                    ok({
                        offers: [
                            {
                                inviteId: 'iiiiiiiiiiiiiiiiiiiiiiiiii',
                                orgName: 'Acme',
                                inviterEmail: 'boss@example.test',
                                teamNames: [],
                                expiresAt: NOW + 86_400_000,
                            },
                        ],
                    }),
                );
            },
        });
        expect(app.api.callsTo(apiRoutes.listInviteOffers)).toEqual([]);
        await app.user.click(await screen.findByRole('button', { name: 'Register new passkey' }));
        const offers = await screen.findByRole('list', { name: 'Invitations' });
        expect(within(offers).getByText("You're invited to Acme by boss@example.test")).toBeTruthy();
        expect(within(offers).getByRole('button', { name: 'Join' })).toBeTruthy();
    });

    describe('from an invitation (D-35)', () => {
        const OFFER = {
            inviteId: 'iiiiiiiiiiiiiiiiiiiiiiiiii',
            orgName: 'Acme',
            inviterEmail: 'boss@example.test',
            teamNames: [],
            expiresAt: NOW + 86_400_000,
        };

        it('speaks of adding a passkey, still names both effects, and puts the invitation first', async () => {
            const app = renderApp({
                path: `/recover?via=invite#${TOKEN}`,
                script: (api) => {
                    recoveryScript(api);
                    api.on(apiRoutes.listInviteOffers, ok({ offers: [OFFER] }));
                },
            });
            expect(await screen.findByRole('heading', { name: 'Add a passkey on this device' })).toBeTruthy();
            expect(app.history.location.hash).toBe('');
            expect(app.history.location.search).toBe('?via=invite');
            expect(screen.getByText(/signs out your other devices, and for 72 hours/)).toBeTruthy();
            expect(screen.queryByText(/recover/i)).toBeNull();
            await expectNoAxeViolations(app.container);

            app.api.on(apiRoutes.getSession, ok(recovered));
            await app.user.click(screen.getByRole('button', { name: 'Add a passkey on this device' }));
            expect(await screen.findByRole('heading', { name: 'Your passkey is ready' })).toBeTruthy();
            const offers = await screen.findByRole('list', { name: 'Invitations' });
            expect(within(offers).getByText("You're invited to Acme by boss@example.test")).toBeTruthy();
            expect(screen.getByText(/Your other devices were signed out/)).toBeTruthy();
            expect(screen.queryByText(/recover/i)).toBeNull();
            // Never accepted on its own: joining waits for the click.
            expect(app.api.callsTo(apiRoutes.acceptInviteOffer)).toEqual([]);
            await expectNoAxeViolations(app.container);

            app.api.on(apiRoutes.acceptInviteOffer, ok({ orgId: recovered.activeOrg.id, teamIds: [] }));
            app.api.on(apiRoutes.setActiveOrg, ok(recovered));
            await app.user.click(within(offers).getByRole('button', { name: 'Join' }));
            expect(await screen.findByRole('heading', { name: "You're in" })).toBeTruthy();
        });

        it('leads to the dashboard when the invitation is gone by then', async () => {
            const app = renderApp({
                path: `/recover?via=invite#${TOKEN}`,
                script: (api) => {
                    recoveryScript(api);
                    api.on(apiRoutes.listInviteOffers, ok({ offers: [] }));
                },
            });
            await app.user.click(await screen.findByRole('button', { name: 'Add a passkey on this device' }));
            expect(await screen.findByRole('heading', { name: 'Your passkey is ready' })).toBeTruthy();
            expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toBeTruthy();
            expect(screen.queryByRole('list', { name: 'Invitations' })).toBeNull();
        });

        it('ignores any other hint', async () => {
            renderApp({ path: `/recover?via=elsewhere#${TOKEN}`, script: recoveryScript });
            expect(await screen.findByRole('heading', { name: 'Register a new passkey' })).toBeTruthy();
        });
    });

    it('stays reachable while signed in', async () => {
        renderApp({ path: '/recover', session: session(), script: recoveryScript });
        expect(await screen.findByRole('heading', { name: 'Recover access' })).toBeTruthy();
    });

    it('explains an expired or malformed link and starts over', async () => {
        const app = renderApp({
            path: `/recover#${TOKEN}`,
            script: (api) => {
                recoveryScript(api);
                api.on(apiRoutes.recoveryOptions, problem(400, 'token-invalid'));
            },
        });
        await app.user.click(await screen.findByRole('button', { name: 'Register new passkey' }));
        await app.user.click(await screen.findByRole('button', { name: 'Get a new link' }));
        expect(await screen.findByRole('heading', { name: 'Recover access' })).toBeTruthy();
        app.unmount();

        const malformed = renderApp({ path: '/recover#x', script: recoveryScript });
        expect(await screen.findByRole('heading', { name: 'This link no longer works' })).toBeTruthy();
        await expectNoAxeViolations(malformed.container);
        await malformed.user.click(screen.getByRole('button', { name: 'Get a new link' }));
        expect(await screen.findByRole('heading', { name: 'Recover access' })).toBeTruthy();
    });

    it('explains a failed registration with a retry', async () => {
        const app = renderApp({ path: `/recover#${TOKEN}`, script: recoveryScript });
        app.passkeys.failNext('cancelled');
        await app.user.click(await screen.findByRole('button', { name: 'Register new passkey' }));
        expect(await screen.findByText(/prompt was closed or timed out/)).toBeTruthy();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('heading', { name: 'Access recovered' })).toBeTruthy();
    });
});
