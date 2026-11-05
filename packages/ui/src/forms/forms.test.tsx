import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { Checkbox } from '../components/checkbox/checkbox';
import { Field } from '../components/field/field';
import { Input } from '../components/input/input';
import { Select } from '../components/select/select';
import { Textarea } from '../components/textarea/textarea';
import { expectNoAxeViolations } from '../testing/axe';
import { renderUi } from '../testing/render';
import { Form, FormSubmit } from './form';
import { errorMessage, FormField } from './form-field';
import { SensitiveInput, useSensitiveInput } from './sensitive-input';
import { applyServerErrors, toFieldName } from './server-errors';
import type { ServerFieldError } from './server-errors';
import { useZodForm } from './use-zod-form';
import type { ZodForm } from './use-zod-form';

const Schema = z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.email('Enter an email address'),
    about: z.string().max(10, 'Keep it short'),
    role: z.enum(['viewer', 'admin']),
    terms: z.boolean().refine((value) => value, 'Accept the terms'),
});
type Values = z.input<typeof Schema>;

const DEFAULTS: Values = { name: '', email: '', about: '', role: 'viewer', terms: false };

interface ProfileFormProps {
    readonly onSubmit: (values: z.output<typeof Schema>, secret: string) => Promise<void>;
    readonly defaults?: Values;
    readonly onForm?: (form: ZodForm<Values>) => void;
}

function ProfileForm({ onSubmit, defaults = DEFAULTS, onForm }: ProfileFormProps) {
    const secret = useSensitiveInput();
    const form = useZodForm({
        schema: Schema,
        defaultValues: defaults,
        onSubmit: async (values) => {
            const value = secret.read();
            try {
                await onSubmit(values, value);
            } catch {
                // An app reports the failure (a toast); the secret is cleared either way.
            } finally {
                secret.clear();
            }
        },
    });
    onForm?.(form);
    return (
        <Form form={form} aria-label="Profile">
            <FormField form={form} name="name" label="Name" hint="As shown to others" required>
                {(control) => <Input {...control.text} />}
            </FormField>
            <FormField form={form} name="email" label="Email">
                {(control) => <Input type="email" {...control.text} />}
            </FormField>
            <FormField form={form} name="about" label="About">
                {(control) => <Textarea {...control.text} />}
            </FormField>
            <FormField form={form} name="role" label="Role">
                {(control) => (
                    <Select {...control.text}>
                        <option value="viewer">{'Viewer'}</option>
                        <option value="admin">{'Admin'}</option>
                    </Select>
                )}
            </FormField>
            <FormField form={form} name="terms" label="Terms">
                {(control) => <Checkbox {...control.checkbox} />}
            </FormField>
            <Field label="API key">{(control) => <SensitiveInput {...control} handle={secret} />}</Field>
            <FormSubmit form={form}>{'Save'}</FormSubmit>
        </Form>
    );
}

function valuesContain(values: unknown, needle: string): boolean {
    return JSON.stringify(values).includes(needle);
}

describe('forms', () => {
    it('links zod errors to their controls and focuses the first invalid field after a failed submit', async () => {
        const onSubmit = vi.fn(() => Promise.resolve());
        const { user } = renderUi(<ProfileForm onSubmit={onSubmit} />);
        const name = screen.getByRole('textbox', { name: /^Name/ });
        expect(name.getAttribute('aria-invalid')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(document.activeElement).toBe(name);
        });
        expect(name.getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByRole('textbox', { name: /^Name.*required/ }).id).toBe(name.id);
        const describedBy = (name.getAttribute('aria-describedby') ?? '').split(' ');
        expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toEqual([
            'As shown to others',
            'Name is required',
        ]);
        const email = screen.getByRole('textbox', { name: 'Email' });
        expect(document.getElementById(email.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
            'Enter an email address',
        );
        expect(screen.getByRole('status').textContent).toBe('Check the highlighted fields');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('revalidates on change after the first submit, and submits parsed values with Enter', async () => {
        const onSubmit = vi.fn(() => Promise.resolve());
        const { user } = renderUi(<ProfileForm onSubmit={onSubmit} />);
        const name = screen.getByRole('textbox', { name: /^Name/ });
        await user.type(name, 'A');
        expect(name.getAttribute('aria-invalid')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(screen.getByRole('textbox', { name: 'Email' }).getAttribute('aria-invalid')).toBe('true');
        });
        await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.com');
        expect(screen.getByRole('textbox', { name: 'Email' }).getAttribute('aria-invalid')).toBeNull();
        await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'admin');
        await user.click(screen.getByRole('checkbox', { name: 'Terms' }));
        await user.click(screen.getByRole('checkbox', { name: 'Terms' }));
        await user.click(screen.getByRole('checkbox', { name: 'Terms' }));
        await user.type(screen.getByRole('textbox', { name: 'About' }), 'Hi');

        await user.click(name);
        await user.keyboard('{Enter}');

        await waitFor(() => {
            expect(onSubmit).toHaveBeenCalledOnce();
        });
        expect(onSubmit).toHaveBeenCalledWith(
            { name: 'A', email: 'ada@example.com', about: 'Hi', role: 'admin', terms: true },
            '',
        );
        expect(screen.getByRole('status').textContent).toBe('');
    });

    it('keeps the submit button busy while onSubmit runs', async () => {
        let finish: () => void = () => undefined;
        const onSubmit = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const { user } = renderUi(
            <ProfileForm onSubmit={onSubmit} defaults={{ ...DEFAULTS, name: 'Ada', email: 'a@b.cz', terms: true }} />,
        );
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-busy')).toBe('true');
        });
        await act(async () => {
            finish();
            await Promise.resolve();
        });
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-busy')).toBeNull();
        });
    });

    it.each([
        ['success', () => Promise.resolve()],
        ['failure', () => Promise.reject(new Error('refused'))],
    ])('reads a sensitive value once and keeps it out of the store and the DOM (%s)', async (_, outcome) => {
        let form: ZodForm<Values> | undefined;
        const seen: string[] = [];
        const onSubmit = vi.fn((_values: unknown, secret: string) => {
            seen.push(secret);
            return outcome();
        });
        const { user, container } = renderUi(
            <ProfileForm
                onSubmit={onSubmit}
                defaults={{ ...DEFAULTS, name: 'Ada', email: 'a@b.cz', terms: true }}
                onForm={(instance) => {
                    form = instance;
                }}
            />,
        );
        const secretInput = screen.getByLabelText('API key');
        expect(secretInput.getAttribute('type')).toBe('password');
        expect(secretInput.getAttribute('autocomplete')).toBe('new-password');
        await user.type(secretInput, 'sk-very-secret');
        expect(valuesContain(form?.state.values, 'sk-very-secret')).toBe(false);

        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(onSubmit).toHaveBeenCalledOnce();
        });
        await waitFor(() => {
            expect((secretInput as HTMLInputElement).value).toBe('');
        });
        expect(seen).toEqual(['sk-very-secret']);
        expect(Object.keys(form?.state.values ?? {})).toEqual(['name', 'email', 'about', 'role', 'terms']);
        expect(valuesContain(form?.state, 'sk-very-secret')).toBe(false);
        expect(container.textContent).not.toContain('sk-very-secret');
        for (const input of container.querySelectorAll('input, textarea')) {
            expect((input as HTMLInputElement).value).not.toContain('sk-very-secret');
            expect(input.getAttribute('value') ?? '').not.toContain('sk-very-secret');
        }
    });

    it('shows server errors on matching fields until they change, and returns the rest', async () => {
        let form: ZodForm<Values> | undefined;
        const { user } = renderUi(
            <ProfileForm
                onSubmit={() => Promise.resolve()}
                onForm={(instance) => {
                    form = instance;
                }}
            />,
        );
        const errors: ServerFieldError[] = [
            { path: '/email', message: 'Already taken' },
            { path: 'name', message: 'Reserved name' },
            { path: '/organization/name', message: 'Unknown organization' },
        ];
        let unmatched: ServerFieldError[] = [];
        act(() => {
            unmatched = form === undefined ? [] : applyServerErrors(form, errors);
        });
        expect(unmatched).toEqual([{ path: '/organization/name', message: 'Unknown organization' }]);
        const email = screen.getByRole('textbox', { name: 'Email' });
        expect(email.getAttribute('aria-invalid')).toBe('true');
        expect(document.getElementById(email.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
            'Already taken',
        );
        expect(screen.getByText('Reserved name')).toBeDefined();

        await user.type(email, 'x');
        expect(email.getAttribute('aria-invalid')).toBeNull();
        expect(screen.queryByText('Already taken')).toBeNull();
        expect(screen.getByText('Reserved name')).toBeDefined();
    });

    it.each(['light', 'dark'] as const)('has no axe violations with errors shown (%s)', async (theme) => {
        const { container, user } = renderUi(<ProfileForm onSubmit={() => Promise.resolve()} />, { theme });
        await expectNoAxeViolations(container);
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await screen.findByText('Name is required');
        await expectNoAxeViolations(container);
    });
});

describe('form helpers', () => {
    it('turn every path notation into a field name', () => {
        expect(toFieldName('name')).toBe('name');
        expect(toFieldName('a.b')).toBe('a.b');
        expect(toFieldName('/a/b')).toBe('a.b');
        expect(toFieldName('/items/0/label')).toBe('items[0].label');
        expect(toFieldName('items.0.label')).toBe('items[0].label');
        expect(toFieldName('items[0].label')).toBe('items[0].label');
        expect(toFieldName('/a~1b/c~0d')).toBe('a/b.c~d');
    });

    it('read messages from schema issues and server strings only', () => {
        expect(errorMessage('Taken')).toBe('Taken');
        expect(errorMessage({ message: 'Too short' })).toBe('Too short');
        expect(errorMessage({ message: 3 })).toBeUndefined();
        expect(errorMessage(null)).toBeUndefined();
    });

    it('lets a sensitive input be cleared and read before it mounts', () => {
        const reads: string[] = [];
        function Probe() {
            const handle = useSensitiveInput();
            return (
                <button
                    type="button"
                    onClick={() => {
                        handle.clear();
                        reads.push(handle.read());
                    }}
                >
                    {'Read'}
                </button>
            );
        }
        renderUi(<Probe />);
        screen.getByRole('button', { name: 'Read' }).click();
        expect(reads).toEqual(['']);
    });

    it('reveals a sensitive value on request without losing what was typed', async () => {
        function Probe({ revealed }: { readonly revealed: boolean }) {
            return <SensitiveInput aria-label="Password" handle={useSensitiveInput()} revealed={revealed} />;
        }
        const { rerender, user } = renderUi(<Probe revealed={false} />);
        const input = screen.getByLabelText('Password');
        expect(input.getAttribute('type')).toBe('password');
        await user.type(input, 'hunter2');
        rerender(<Probe revealed />);
        expect(input.getAttribute('type')).toBe('text');
        expect((input as HTMLInputElement).value).toBe('hunter2');
    });
});
