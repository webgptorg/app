import { useSelector } from '@tanstack/react-form';
import { useEffect, useRef, useState } from 'react';
import type { FormHTMLAttributes, ReactNode, SyntheticEvent } from 'react';

import { Button } from '../components/button/button';
import type { ButtonProps } from '../components/button/button';
import { useUiMessages } from '../i18n/ui-provider';
import type { ZodForm } from './use-zod-form';

export interface FormProps<Values> extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'noValidate'> {
    readonly form: ZodForm<Values>;
    readonly children: ReactNode;
}

/**
 * A `<form>` driven by a `useZodForm` form. The browser's own validation is off (the schema decides, with translated
 * messages); after a submit the schema refuses, focus moves to the first invalid field and a polite status says so.
 */
export function Form<Values>({ form, children, ...rest }: FormProps<Values>) {
    const messages = useUiMessages();
    const element = useRef<HTMLFormElement>(null);
    const [failedAttempts, setFailedAttempts] = useState(0);
    const isValid = useSelector(form.store, (state) => state.isValid);

    useEffect(() => {
        if (failedAttempts === 0) return;
        element.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }, [failedAttempts]);

    const handleSubmit = async (event: SyntheticEvent<HTMLFormElement>) => {
        event.preventDefault();
        event.stopPropagation();
        await form.handleSubmit();
        if (!form.state.isValid) setFailedAttempts((count) => count + 1);
    };

    return (
        <form {...rest} ref={element} noValidate onSubmit={(event) => void handleSubmit(event)}>
            {children}
            <p role="status" className="sr-only">
                {failedAttempts > 0 && !isValid ? messages.formInvalid() : null}
            </p>
        </form>
    );
}

export interface FormSubmitProps<Values> extends Omit<ButtonProps, 'type' | 'loading' | 'form'> {
    readonly form: ZodForm<Values>;
}

/** The form's primary submit button, busy while `onSubmit` runs. */
export function FormSubmit<Values>({ form, variant = 'primary', ...rest }: FormSubmitProps<Values>) {
    const isSubmitting = useSelector(form.store, (state) => state.isSubmitting);
    return <Button {...rest} variant={variant} type="submit" loading={isSubmitting} />;
}
