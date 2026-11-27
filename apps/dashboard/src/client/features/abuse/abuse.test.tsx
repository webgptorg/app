import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { engineView, ENGINE_ID, session } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';
import { ok, problem } from '../../testing/scripted-api';

const CONTACT = ok({ email: 'abuse@ptbk.test' });

describe('abuse page', () => {
    it('tells anyone, signed out, how to report and what we can and cannot see', async () => {
        const app = renderApp({ path: '/abuse', script: (api) => api.on(apiRoutes.getAbuseContact, CONTACT) });
        expect(await screen.findByRole('heading', { name: 'Report abuse', level: 1 })).toBeTruthy();
        const mail = await screen.findByRole('link', { name: 'abuse@ptbk.test' });
        expect(mail.getAttribute('href')).toBe('mailto:abuse@ptbk.test');
        expect(screen.getByRole('heading', { name: 'What we can and cannot see' })).toBeTruthy();
        expect(screen.getByText(/We cannot see what a project shows to signed-in users/)).toBeTruthy();
        expect(screen.getByText(/We cannot delete anything from the owner's server/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'security.txt' }).getAttribute('href')).toBe(
            '/.well-known/security.txt',
        );
        expect(app.api.callsTo(apiRoutes.listEngines)).toEqual([]);
        await expectNoAxeViolations(app.container);
    });

    it('still explains everything when the address cannot be loaded', async () => {
        renderApp({
            path: '/abuse',
            script: (api) => api.on(apiRoutes.getAbuseContact, problem(429, 'rate-limited')),
        });
        expect(await screen.findByText('The address could not be loaded. Try again later.')).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'How to report' })).toBeTruthy();
    });

    it('gives the owner of an engine the platform suspended the abuse contact', async () => {
        renderApp({
            path: `/engines/${ENGINE_ID}`,
            session: session(),
            script: (api) => {
                api.on(apiRoutes.getAbuseContact, CONTACT);
                api.on(
                    apiRoutes.getEngine,
                    ok({ engine: engineView({ status: 'suspended', suspendedBy: 'platform' }) }),
                );
            },
        });
        expect(await screen.findByText(/Promptbook suspended this project/)).toBeTruthy();
        expect((await screen.findByRole('link', { name: 'abuse@ptbk.test' })).getAttribute('href')).toBe(
            'mailto:abuse@ptbk.test',
        );
        expect(screen.getByRole('link', { name: 'How we handle abuse' }).getAttribute('href')).toBe('/abuse');
    });
});
