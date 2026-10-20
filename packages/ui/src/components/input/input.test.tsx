import { screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Input } from './input';

describe('Input', () => {
    it.each(['light', 'dark'] as const)('is a labelled, typeable text box (%s)', async (theme) => {
        const { container, user } = renderUi(
            <label>
                {'Name'}
                <Input />
            </label>,
            { theme },
        );
        const input = screen.getByRole('textbox', { name: 'Name' });
        expect(input.getAttribute('type')).toBe('text');
        await user.tab();
        expect(document.activeElement).toBe(input);
        await user.keyboard('Ada');
        expect(input).toHaveProperty('value', 'Ada');
        await expectNoAxeViolations(container);
    });

    it('marks itself invalid unless the caller decided, and forwards its ref', () => {
        const ref = createRef<HTMLInputElement>();
        renderUi(
            <>
                <Input aria-label="a" invalid ref={ref} />
                <Input aria-label="b" invalid aria-invalid={false} />
                <Input aria-label="c" aria-invalid="true" />
                <Input aria-label="d" />
            </>,
        );
        expect(screen.getByRole('textbox', { name: 'a' }).getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByRole('textbox', { name: 'b' }).hasAttribute('aria-invalid')).toBe(false);
        expect(screen.getByRole('textbox', { name: 'c' }).getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByRole('textbox', { name: 'd' }).hasAttribute('aria-invalid')).toBe(false);
        expect(ref.current).toBe(screen.getByRole('textbox', { name: 'a' }));
    });
});
