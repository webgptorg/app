import { useField } from '@tanstack/react-form';
import type { DeepKeys } from '@tanstack/react-form';
import type { ChangeEvent, ReactNode } from 'react';

import { Field } from '../components/field/field';
import type { FieldControlProps } from '../components/field/field';
import type { ZodForm } from './use-zod-form';

/** Props for a text-like control (`Input`, `Textarea`, `Select`) bound to one form field. */
export interface TextControlProps extends FieldControlProps {
    readonly name: string;
    readonly value: string;
    readonly onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
    readonly onBlur: () => void;
}

/** Props for a `Checkbox` or `Switch` bound to one boolean form field. */
export interface CheckboxControlProps extends FieldControlProps {
    readonly name: string;
    readonly checked: boolean;
    readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    readonly onBlur: () => void;
}

export interface FormFieldControl {
    readonly text: TextControlProps;
    readonly checkbox: CheckboxControlProps;
}

export interface FormFieldProps<Values, Name extends DeepKeys<Values>> {
    readonly form: ZodForm<Values>;
    readonly name: Name;
    readonly label: ReactNode;
    readonly hint?: ReactNode;
    readonly required?: boolean;
    readonly className?: string;
    /** Spread `control.text` onto `Input`/`Textarea`/`Select`, or `control.checkbox` onto `Checkbox`/`Switch`. */
    readonly children: (control: FormFieldControl) => ReactNode;
}

/** Schema issues arrive as objects with a `message`, server errors (`applyServerErrors`) as strings. */
export function errorMessage(error: unknown): string | undefined {
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
        return error.message;
    }
    return undefined;
}

/** One form field wired to `Field`: its first error is the control's description and marks it `aria-invalid`. */
export function FormField<Values, Name extends DeepKeys<Values>>({
    form,
    name,
    label,
    hint,
    required,
    className,
    children,
}: FormFieldProps<Values, Name>) {
    const field = useField({ form, name });
    const error = field.state.meta.errors.map(errorMessage).find((message) => message !== undefined);
    const value: unknown = field.state.value;
    const update = (next: unknown) => {
        // A server error describes the value the server saw; before the first submit no validator runs on change
        // to clear it, so it goes as soon as the member edits the field.
        if (field.state.meta.errorMap.onServer !== undefined) {
            field.setMeta((meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: undefined } }));
        }
        field.handleChange(next as Parameters<typeof field.handleChange>[0]);
    };
    return (
        <Field
            label={label}
            hint={hint}
            error={error}
            {...(required === undefined ? {} : { required })}
            {...(className === undefined ? {} : { className })}
        >
            {(control) =>
                children({
                    text: {
                        ...control,
                        name,
                        value: typeof value === 'string' || typeof value === 'number' ? String(value) : '',
                        onChange: (event) => {
                            update(event.target.value);
                        },
                        onBlur: field.handleBlur,
                    },
                    checkbox: {
                        ...control,
                        name,
                        checked: value === true,
                        onChange: (event) => {
                            update(event.target.checked);
                        },
                        onBlur: field.handleBlur,
                    },
                })
            }
        </Field>
    );
}
