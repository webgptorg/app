import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { LINK_CODE } from '../../testing/fixtures';
import { APP_ORIGIN, renderApp } from '../../testing/render-app';

describe('link page', () => {
    it('tells whoever opened a link URL to run it on the engine, and sends the code nowhere', async () => {
        const app = renderApp({ path: `/link#${LINK_CODE}` });
        expect(await screen.findByRole('heading', { name: 'Link your engine', level: 1 })).toBeTruthy();
        expect(screen.getByText('To link your engine, run this on the machine where it runs:')).toBeTruthy();
        const command = `ptbk connect --link '${APP_ORIGIN}/link#${LINK_CODE}'`;
        expect(screen.getByText(command)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
        expect(JSON.stringify(app.api.calls)).not.toContain(LINK_CODE);
        await expectNoAxeViolations(app.container);
    });

    it.each(['/link', '/link#', '/link#not-a-code'])('says what to run without a valid code: %s', async (path) => {
        renderApp({ path });
        expect(await screen.findByRole('heading', { name: 'Link your engine', level: 1 })).toBeTruthy();
        expect(screen.getByText(/run ptbk connect --link with the full address the dashboard showed you/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull();
    });
});
