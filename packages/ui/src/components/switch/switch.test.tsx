import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Switch } from './switch';

describe('Switch', () => {
    it.each(['light', 'dark'] as const)('is a labelled switch that Space toggles (%s)', async (theme) => {
        const { container, user } = renderUi(<Switch label="Live updates" description="Refresh as runs change" />, {
            theme,
        });
        const control = screen.getByRole('switch', { name: 'Live updates' });
        expect(document.getElementById(control.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
            'Refresh as runs change',
        );
        await user.tab();
        expect(document.activeElement).toBe(control);
        await user.keyboard(' ');
        expect(control).toHaveProperty('checked', true);
        await expectNoAxeViolations(container);
    });

    it('has no description link without a description and keeps a given id', () => {
        renderUi(<Switch id="x" label="Paused" defaultChecked />);
        const control = screen.getByRole('switch', { name: 'Paused' });
        expect(control.id).toBe('x');
        expect(control.hasAttribute('aria-describedby')).toBe(false);
        expect(control).toHaveProperty('checked', true);
    });
});
