import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { RelativeTime } from './relative-time';

const NOW = new Date('2026-10-20T12:00:00.000Z');

describe('RelativeTime', () => {
    it.each(['light', 'dark'] as const)(
        'reads relative to now with the exact time machine-readable (%s)',
        async (theme) => {
            const value = new Date('2026-10-20T11:57:00.000Z');
            const { container } = renderUi(<RelativeTime value={value} now={NOW} className="x" />, { theme });
            const time = screen.getByText('3 minutes ago');
            expect(time.tagName).toBe('TIME');
            expect(time.getAttribute('datetime')).toBe(value.toISOString());
            expect(time.getAttribute('title')).toMatch(/2026/);
            await expectNoAxeViolations(container);
        },
    );

    it('formats in the provider locale and defaults now to the render time', () => {
        renderUi(<RelativeTime value={new Date('2026-10-22T12:00:00.000Z')} now={NOW} />, { locale: 'cs' });
        expect(screen.getByText('pozítří')).toBeDefined();
        const { container } = renderUi(<RelativeTime value={new Date()} />);
        expect(container.querySelector('time')?.textContent).toBe('now');
    });
});
