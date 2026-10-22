import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { expectNoAxeViolations } from '../../testing/axe';
import { APP_ORIGIN, renderApp } from '../../testing/render-app';
import { ok, problem } from '../../testing/scripted-api';

function email(to: string, text: string, subject = 'Finish signing up') {
    return { template: 'signup-link', to, locale: 'en' as const, subject, text };
}

describe('dev mailbox', () => {
    it('lists every recorded email, newest first, with links to the dashboard clickable', async () => {
        const link = `${APP_ORIGIN}/signup#${'a'.repeat(43)}`;
        const app = renderApp({
            path: '/__dev/mailbox',
            script: (api) =>
                api.on(
                    apiRoutes.devEmails,
                    ok({
                        emails: [
                            email('old@example.test', 'Older message', 'Older'),
                            email('new@example.test', `Create your passkey: ${link}\nOr https://elsewhere.test/x`),
                        ],
                    }),
                ),
        });
        expect(await screen.findByRole('heading', { name: 'Dev mailbox', level: 1 })).toBeTruthy();
        const items = screen.getAllByRole('listitem');
        expect(items.map((item) => within(item).getByRole('heading').textContent)).toEqual([
            'Finish signing up',
            'Older',
        ]);
        expect(within(items[0] as HTMLElement).getByText('To new@example.test')).toBeTruthy();
        expect(screen.getByRole('link', { name: link }).getAttribute('href')).toBe(link);
        expect(screen.queryByRole('link', { name: /elsewhere/ })).toBeNull();
        expect(app.api.callsTo(apiRoutes.devEmails)).toContainEqual({ query: {} });
        await expectNoAxeViolations(app.container);
    });

    it('shows an empty outbox as such', async () => {
        renderApp({ path: '/__dev/mailbox', script: (api) => api.on(apiRoutes.devEmails, ok({ emails: [] })) });
        expect(await screen.findByRole('heading', { name: 'No emails yet' })).toBeTruthy();
    });

    it('does not exist where the dashboard runs another email adapter (the outbox answers 404)', async () => {
        renderApp({
            path: '/__dev/mailbox',
            script: (api) => api.on(apiRoutes.devEmails, problem(404, 'not-found')),
        });
        expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Dev mailbox' })).toBeNull();
    });
});
