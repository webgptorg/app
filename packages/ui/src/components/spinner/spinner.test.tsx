import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Spinner } from './spinner';

describe('Spinner', () => {
    it.each(['light', 'dark'] as const)('announces loading as a status (%s)', async (theme) => {
        const { container } = renderUi(<Spinner />, { theme });
        expect(screen.getByRole('status').textContent).toBe('Loading');
        await expectNoAxeViolations(container);
    });

    it('stays silent when the container already announces it, and is never focusable', () => {
        const { container } = renderUi(<Spinner announce={false} size="sm" tone="current" />);
        expect(screen.queryByRole('status')).toBeNull();
        expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
        expect(container.querySelector('[tabindex]')).toBeNull();
    });
});
