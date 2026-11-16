import { screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Field } from '../field/field';
import { DateInput } from './date-input';

describe('DateInput', () => {
    it.each(['light', 'dark'] as const)(
        'renders a labelled native date input without axe violations (%s)',
        async (theme) => {
            const { container } = renderUi(
                <Field label="Due date" hint="Agents stop working on it after this day.">
                    {(control) => <DateInput {...control} defaultValue="2026-11-13" />}
                </Field>,
                { theme },
            );
            const input = screen.getByLabelText<HTMLInputElement>('Due date');
            expect(input.type).toBe('date');
            expect(input.value).toBe('2026-11-13');
            expect(input.getAttribute('aria-describedby')).toBe(`${input.id}-hint`);
            expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
            await expectNoAxeViolations(container);
        },
    );

    it('takes a time of day with withTime', () => {
        renderUi(<DateInput aria-label="Starts" withTime defaultValue="2026-11-13T09:30" />);
        const input = screen.getByLabelText<HTMLInputElement>('Starts');
        expect(input.type).toBe('datetime-local');
        expect(input.value).toBe('2026-11-13T09:30');
    });

    it('forwards the ref and native props, and sizes the wrapper', async () => {
        const ref = createRef<HTMLInputElement>();
        const onChange = vi.fn();
        const { user } = renderUi(
            <DateInput
                ref={ref}
                aria-label="Due"
                name="due"
                min="2026-01-01"
                required
                className="max-w-xs"
                onChange={onChange}
            />,
        );
        const input = screen.getByLabelText<HTMLInputElement>('Due');
        expect(ref.current).toBe(input);
        expect(input.name).toBe('due');
        expect(input.min).toBe('2026-01-01');
        expect(input.required).toBe(true);
        expect(input.parentElement?.className).toContain('max-w-xs');
        await user.type(input, '2026-12-24');
        expect(onChange).toHaveBeenCalled();
        expect(input.value).toBe('2026-12-24');
    });

    it('marks itself invalid unless the caller says otherwise', () => {
        const { rerender } = renderUi(<DateInput aria-label="Due" invalid />);
        expect(screen.getByLabelText('Due').getAttribute('aria-invalid')).toBe('true');
        rerender(<DateInput aria-label="Due" invalid aria-invalid={false} />);
        expect(screen.getByLabelText('Due').hasAttribute('aria-invalid')).toBe(false);
        rerender(<DateInput aria-label="Due" disabled />);
        expect(screen.getByLabelText<HTMLInputElement>('Due').disabled).toBe(true);
    });
});
