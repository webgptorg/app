import { screen } from '@testing-library/react';
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
