import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { LINK_CODE } from '../../testing/fixtures';
import { renderApp } from '../../testing/render-app';

// Paraglide resolves the first locale once per page load, so the Czech page lives in its own test file.
describe('link page for a Czech browser', () => {
    beforeEach(() => {
        vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['cs-CZ', 'cs', 'en']);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders in Czech', async () => {
        const app = renderApp({ path: `/link#${LINK_CODE}` });
        expect(await screen.findByRole('heading', { name: 'Propojení projektu', level: 1 })).toBeTruthy();
        expect(screen.getByText('Projekt propojíte tak, že na počítači, kde běží, spustíte:')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Kopírovat příkaz' })).toBeTruthy();
        await expectNoAxeViolations(app.container);
    });
});
