import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { VisuallyHidden } from './visually-hidden';

describe('VisuallyHidden', () => {
    it.each(['light', 'dark'] as const)('keeps text in the accessible name of its parent (%s)', async (theme) => {
        const { container, user } = renderUi(
            <button type="button">
                <span aria-hidden="true">{'×'}</span>
                <VisuallyHidden className="x">{'Close dialog'}</VisuallyHidden>
            </button>,
            { theme },
        );
        const button = screen.getByRole('button', { name: 'Close dialog' });
        await user.tab();
        expect(document.activeElement).toBe(button);
        expect(screen.getByText('Close dialog').className).toBe('sr-only x');
        await expectNoAxeViolations(container);
    });

    it('uses only the sr-only utility by default', () => {
        renderUi(<VisuallyHidden>{'Hidden'}</VisuallyHidden>);
        expect(screen.getByText('Hidden').className).toBe('sr-only');
    });
});
