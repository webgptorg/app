import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { EmptyValue } from './empty-value';

describe('EmptyValue', () => {
    it.each(['light', 'dark'] as const)('shows a dash and tells screen readers why (%s)', async (theme) => {
        const { container } = renderUi(
            <p>
                {'Cost: '}
                <EmptyValue label="Not reported" />
            </p>,
            { theme },
        );
        expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
        expect(screen.getByText('Not reported').className).toContain('sr-only');
        await expectNoAxeViolations(container);
    });
});
