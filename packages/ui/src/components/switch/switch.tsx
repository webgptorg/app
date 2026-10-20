import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

import { cx } from '../../internal/cx';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'> {
    readonly label: ReactNode;
    readonly description?: ReactNode;
    readonly ref?: Ref<HTMLInputElement>;
}

/**
 * An on/off setting that applies at once. A native checkbox with `role="switch"`, so it keeps form semantics and
 * Space toggles it; the track and thumb are drawn from the input's own `:checked` state.
 */
export function Switch({ label, description, className, id, ...rest }: SwitchProps) {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const descriptionId = `${inputId}-description`;
    return (
        <div className={cx('flex items-start justify-between gap-4', className)}>
            <span className="flex flex-col gap-0.5">
                <label htmlFor={inputId} className="cursor-pointer text-sm text-(--switch-label)">
                    {label}
                </label>
                {description === undefined ? null : (
                    <span id={descriptionId} className="text-sm text-(--switch-description)">
                        {description}
                    </span>
                )}
            </span>
            <input
                {...rest}
                id={inputId}
                type="checkbox"
                role="switch"
                aria-describedby={cx(rest['aria-describedby'], description !== undefined && descriptionId) || undefined}
                className={cx(
                    'relative h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-pill border border-(--switch-border) bg-(--switch-track)',
                    'before:absolute before:start-0.5 before:top-0.5 before:size-4.5 before:rounded-pill before:bg-(--switch-thumb) before:shadow-subtle',
                    'checked:border-(--switch-track-on) checked:bg-(--switch-track-on) checked:before:translate-x-4 rtl:checked:before:-translate-x-4',
                    'motion-safe:transition-colors motion-safe:duration-(--motion-state) motion-safe:before:transition-transform motion-safe:before:duration-(--motion-state)',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                )}
            />
        </div>
    );
}
