import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderUi } from '../../testing/render';
import { Input } from '../input/input';
import { Field } from './field';

describe('Field', () => {
    it.each(['light', 'dark'] as const)('labels its control and links hint and error (%s)', async (theme) => {
        const { container, user } = renderUi(
            <Field label="Name" hint="Shown to members" error="Name is required" required>
                {(control) => <Input {...control} />}
            </Field>,
            { theme },
        );
        const input = screen.getByRole('textbox', { name: /^Name\s*\(required\)$/ });
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(input.hasAttribute('required')).toBe(true);
        const described = (input.getAttribute('aria-describedby') ?? '')
            .split(' ')
            .map((id) => document.getElementById(id)?.textContent);
        expect(described).toEqual(['Shown to members', 'Name is required']);
        await user.tab();
        expect(document.activeElement).toBe(input);
        await expectNoAxeViolations(container);
    });

    it('describes nothing and is valid without hint or error, and keeps a given id', () => {
        renderUi(
            <Field label="Email" id="email">
                {(control) => <Input {...control} type="email" />}
            </Field>,
        );
        const input = screen.getByRole('textbox', { name: 'Email' });
        expect(input.id).toBe('email');
        expect(input.hasAttribute('aria-describedby')).toBe(false);
        expect(input.hasAttribute('aria-invalid')).toBe(false);
        expect(input.hasAttribute('required')).toBe(false);
    });

    it('treats an empty error as no error', () => {
        renderUi(
            <Field label="Title" error="" hint="">
                {(control) => <Input {...control} />}
            </Field>,
        );
        expect(screen.getByRole('textbox', { name: 'Title' }).hasAttribute('aria-invalid')).toBe(false);
    });
});
