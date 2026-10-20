import { useId } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';

import { cx } from '../../internal/cx';
import { Spinner } from '../spinner/spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
    /** Shows a spinner, sets `aria-busy` and ignores clicks, keeping the label so the width does not jump. */
    readonly loading?: boolean;
    readonly disabled?: boolean;
    /**
     * Why a disabled action is unavailable (e.g. a missing permission). With it, a disabled button stays focusable
     * with `aria-disabled`, so keyboard and screen reader users can reach the reason.
     */
    readonly disabledReason?: string;
    /** Renders nothing; for actions the member may not see at all. */
    readonly hidden?: boolean;
    readonly ref?: Ref<HTMLButtonElement>;
    readonly children: ReactNode;
}

const VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
    primary:
        'bg-(--button-primary-bg) text-(--button-primary-text) hover:enabled:bg-(--button-primary-bg-hover) shadow-subtle',
    secondary:
        'border border-(--button-secondary-border) bg-(--button-secondary-bg) text-(--button-secondary-text) hover:enabled:bg-(--button-secondary-bg-hover)',
    ghost: 'bg-transparent text-(--button-ghost-text) hover:enabled:bg-(--button-ghost-bg-hover)',
    danger: 'bg-(--button-danger-bg) text-(--button-danger-text) hover:enabled:bg-(--button-danger-bg-hover)',
};

const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
    sm: 'min-h-8 gap-1.5 px-3 text-sm',
    md: 'min-h-10 gap-2 px-4 text-sm',
};

/** Shared by `Button` and `IconButton` so both look and behave the same. */
export function buttonClassName(variant: ButtonVariant, size: ButtonSize, className?: string): string {
    return cx(
        'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-(--button-radius) font-medium whitespace-nowrap select-none',
        'motion-safe:transition-colors motion-safe:duration-(--motion-state) motion-safe:ease-standard',
        'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-busy:cursor-progress',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
    );
}

export function Button({
    variant = 'secondary',
    size = 'md',
    loading = false,
    disabled = false,
    disabledReason,
    hidden = false,
    type = 'button',
    className,
    onClick,
    children,
    ...rest
}: ButtonProps) {
    const reasonId = useId();
    if (hidden) return null;
    const softDisabled = disabled && disabledReason !== undefined;
    const blocked = loading || softDisabled;
    const describedBy = cx(rest['aria-describedby'], softDisabled && reasonId) || undefined;
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
        if (blocked) {
            event.preventDefault();
            return;
        }
        onClick?.(event);
    };
    return (
        <>
            <button
                {...rest}
                type={type}
                className={buttonClassName(variant, size, className)}
                disabled={disabled && !softDisabled}
                aria-disabled={softDisabled || undefined}
                aria-busy={loading || undefined}
                aria-describedby={describedBy}
                onClick={handleClick}
            >
                {loading ? <Spinner size="sm" tone="current" announce={false} /> : null}
                {children}
            </button>
            {softDisabled ? (
                <span id={reasonId} hidden>
                    {disabledReason}
                </span>
            ) : null}
        </>
    );
}
