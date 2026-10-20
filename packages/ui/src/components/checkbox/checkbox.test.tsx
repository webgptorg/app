import { screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Checkbox } from './checkbox';

describe('Checkbox', () => {
    it.each(['light', 'dark'] as const)('is labelled, described and toggles with Space (%s)', async (theme) => {
        const onChange = vi.fn();
        const { container, user } = renderUi(
            <Checkbox label="Email me" description="At most once a day" onChange={onChange} className="mt-2" />,
            { theme },
        );
        const checkbox = screen.getByRole('checkbox', { name: 'Email me' });
        expect(document.getElementById(checkbox.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
            'At most once a day',
        );
        await user.tab();
        expect(document.activeElement).toBe(checkbox);
        await user.keyboard(' ');
        expect(checkbox).toHaveProperty('checked', true);
        expect(onChange).toHaveBeenCalledOnce();
        await expectNoAxeViolations(container);
    });

    it('renders a bare input named by aria-label, and reflects the mixed state', () => {
        const ref = createRef<HTMLInputElement>();
        const { rerender } = renderUi(<Checkbox aria-label="Select all" indeterminate ref={ref} />);
        const checkbox = screen.getByRole('checkbox', { name: 'Select all' });
        expect(ref.current).toBe(checkbox);
        expect(checkbox).toHaveProperty('indeterminate', true);
        expect(checkbox.hasAttribute('aria-describedby')).toBe(false);
        rerender(<Checkbox aria-label="Select all" indeterminate={false} ref={ref} />);
        expect(screen.getByRole('checkbox', { name: 'Select all' })).toHaveProperty('indeterminate', false);
    });

    it('passes the input to a callback ref and keeps a given id', () => {
        let received: HTMLInputElement | null = null;
        renderUi(
            <Checkbox
                id="terms"
                label="I agree"
                ref={(element) => {
                    received = element;
                }}
            />,
        );
        expect(received).toBe(screen.getByRole('checkbox', { name: 'I agree' }));
        expect(screen.getByRole('checkbox').id).toBe('terms');
    });
});
