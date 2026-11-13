import { useId } from 'react';
import type { ReactNode } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';

/** What a control inside `Field` spreads onto itself, so its label, hint and error are announced with it. */
export interface FieldControlProps {
    readonly id: string;
    readonly 'aria-describedby': string | undefined;
    readonly 'aria-invalid': true | undefined;
    readonly required: boolean;
}

export interface FieldProps {
    readonly label: ReactNode;
    /** Keeps the label for assistive technology only, where the control explains itself (a chat's message box). */
    readonly labelHidden?: boolean;
    readonly hint?: ReactNode;
    /** Shown under the control and linked to it; also marks the control `aria-invalid`. */
    readonly error?: ReactNode;
    readonly required?: boolean;
    /** The control's id; generated when omitted. */
    readonly id?: string;
    readonly className?: string;
    readonly children: (control: FieldControlProps) => ReactNode;
}

/** Label, hint and error around one control. The control gets its wiring from the render function's argument. */
export function Field({
    label,
    labelHidden = false,
    hint,
    error,
    required = false,
    id,
    className,
    children,
}: FieldProps) {
    const messages = useUiMessages();
    const generatedId = useId();
    const controlId = id ?? generatedId;
    const hintId = `${controlId}-hint`;
    const errorId = `${controlId}-error`;
    const hasError = error !== undefined && error !== null && error !== false && error !== '';
    const hasHint = hint !== undefined && hint !== null && hint !== false && hint !== '';
    const describedBy = cx(hasHint && hintId, hasError && errorId) || undefined;
    return (
        <div className={cx('flex flex-col gap-1.5', className)}>
            <label
                htmlFor={controlId}
                className={cx('text-sm font-medium text-(--field-label)', labelHidden && 'sr-only')}
            >
                {label}
                {required ? (
                    <>
                        <span aria-hidden="true" className="ms-0.5 text-(--field-required)">
                            {'*'}
                        </span>
                        <span className="sr-only">{` (${messages.required()})`}</span>
                    </>
                ) : null}
            </label>
            {children({
                id: controlId,
                'aria-describedby': describedBy,
                'aria-invalid': hasError ? true : undefined,
                required,
            })}
            {hasHint ? (
                <p id={hintId} className="text-xs text-(--field-hint)">
                    {hint}
                </p>
            ) : null}
            {hasError ? (
                <p id={errorId} className="text-xs font-medium text-(--field-error)">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
