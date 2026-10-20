import { useEffect, useId, useRef } from 'react';
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../../internal/cx';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
    /** Visible label; for a checkbox without one (e.g. a table row), pass `aria-label` and no `label`. */
    readonly label?: ReactNode;
    readonly description?: ReactNode;
    /** The mixed state, e.g. "some rows on this page are selected"; DOM-only, so it is set through a ref. */
    readonly indeterminate?: boolean;
    readonly ref?: Ref<HTMLInputElement>;
}

export function Checkbox({ label, description, indeterminate = false, className, id, ref, ...rest }: CheckboxProps) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const descriptionId = `${inputId}-description`;
    const inner = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (inner.current !== null) inner.current.indeterminate = indeterminate;
    }, [indeterminate]);
    const setRefs = (element: HTMLInputElement | null) => {
        inner.current = element;
        if (typeof ref === 'function') ref(element);
        else if (ref !== null && ref !== undefined) ref.current = element;
    };
    const input = (
        <input
            {...rest}
            ref={setRefs}
            id={inputId}
            type="checkbox"
            aria-describedby={cx(rest['aria-describedby'], description !== undefined && descriptionId) || undefined}
            className={cx(
                'size-4 shrink-0 cursor-pointer rounded-small border border-(--checkbox-border) accent-(--checkbox-checked) disabled:cursor-not-allowed disabled:opacity-50',
                label === undefined && className,
            )}
        />
    );
    if (label === undefined) return input;
    return (
        <div className={cx('flex items-start gap-2', className)}>
            <span className="flex min-h-5 items-center">{input}</span>
            <span className="flex flex-col gap-0.5">
                <label htmlFor={inputId} className="cursor-pointer text-sm text-(--checkbox-label)">
                    {label}
                </label>
                {description === undefined ? null : (
                    <span id={descriptionId} className="text-sm text-(--checkbox-description)">
                        {description}
                    </span>
                )}
            </span>
        </div>
    );
}
