import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Textarea } from './textarea';

describe('Textarea', () => {
    it.each(['light', 'dark'] as const)('is a labelled multi-line text box (%s)', async (theme) => {
        const { container, user } = renderUi(<Textarea aria-label="Brief" />, { theme });
        const textarea = screen.getByRole('textbox', { name: 'Brief' });
        expect(textarea.getAttribute('rows')).toBe('4');
        await user.tab();
        expect(document.activeElement).toBe(textarea);
        await user.keyboard('one{Enter}two');
        expect(textarea).toHaveProperty('value', 'one\ntwo');
        await expectNoAxeViolations(container);
    });

    it('marks itself invalid', () => {
        renderUi(<Textarea aria-label="Brief" invalid rows={2} />);
        const textarea = screen.getByRole('textbox', { name: 'Brief' });
        expect(textarea.getAttribute('aria-invalid')).toBe('true');
        expect(textarea.getAttribute('rows')).toBe('2');
    });
});
