import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Select } from './select';

describe('Select', () => {
    it.each(['light', 'dark'] as const)('is a labelled native combobox (%s)', async (theme) => {
        const { container, user } = renderUi(
            <Select aria-label="Theme" defaultValue="light">
                <option value="light">{'Light'}</option>
                <option value="dark">{'Dark'}</option>
            </Select>,
            { theme },
        );
        const select = screen.getByRole('combobox', { name: 'Theme' });
        await user.tab();
        expect(document.activeElement).toBe(select);
        await user.selectOptions(select, 'dark');
        expect(select).toHaveProperty('value', 'dark');
        await expectNoAxeViolations(container);
    });

    it('marks itself invalid', () => {
        renderUi(
            <Select aria-label="Role" invalid>
                <option>{'Owner'}</option>
            </Select>,
        );
        expect(screen.getByRole('combobox', { name: 'Role' }).getAttribute('aria-invalid')).toBe('true');
    });
});
