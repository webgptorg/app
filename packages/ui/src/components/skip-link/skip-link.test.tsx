import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { SkipLink } from './skip-link';

describe('SkipLink', () => {
    it.each(['light', 'dark'] as const)('is the first tab stop and points at the main content (%s)', async (theme) => {
        const { container, user } = renderUi(
            <>
                <SkipLink targetId="main" />
                <nav aria-label="Main">
                    <a href="/agents">{'Agents'}</a>
                </nav>
                <main id="main" tabIndex={-1}>
                    {'Content'}
                </main>
            </>,
            { theme },
        );
        await user.tab();
        const link = screen.getByRole('link', { name: 'Skip to content' });
        expect(document.activeElement).toBe(link);
        expect(link.getAttribute('href')).toBe('#main');
        expect(link.className).toContain('focus:not-sr-only');
        await expectNoAxeViolations(container);
    });
});
