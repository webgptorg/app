import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';

import { cx } from '../../internal/cx';
import { mergeTooltipHandlers, useTooltip } from '../tooltip/tooltip';
import { Spinner } from '../spinner/spinner';

/** `danger-ghost` is for a destructive action that is not the point of the screen; its confirm step uses `danger`. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
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
        'bg-(--button-primary-bg) text-(--button-primary-text) hover:enabled:not-aria-disabled:bg-(--button-primary-bg-hover) shadow-subtle',
    secondary:
        'border border-(--button-secondary-border) bg-(--button-secondary-bg) text-(--button-secondary-text) hover:enabled:not-aria-disabled:bg-(--button-secondary-bg-hover)',
    ghost: 'bg-transparent text-(--button-ghost-text) hover:enabled:not-aria-disabled:bg-(--button-ghost-bg-hover)',
    danger: 'bg-(--button-danger-bg) text-(--button-danger-text) hover:enabled:not-aria-disabled:bg-(--button-danger-bg-hover)',
    'danger-ghost':
        'bg-transparent text-(--button-danger-ghost-text) hover:enabled:not-aria-disabled:bg-(--button-danger-ghost-bg-hover)',
};

/**
 * Inert in both themes through its own tokens, not opacity: a half-transparent accent fill still reads as a live
 * button on a dark surface. Ghost buttons keep no fill, so a disabled one never looks raised.
 */
const DISABLED_CLASSES: Readonly<Record<ButtonVariant, string>> = {
    primary:
        'disabled:border disabled:border-(--button-disabled-border) disabled:bg-(--button-disabled-bg) disabled:shadow-none aria-disabled:border aria-disabled:border-(--button-disabled-border) aria-disabled:bg-(--button-disabled-bg) aria-disabled:shadow-none',
    secondary:
        'disabled:border-(--button-disabled-border) disabled:bg-(--button-disabled-bg) aria-disabled:border-(--button-disabled-border) aria-disabled:bg-(--button-disabled-bg)',
    ghost: '',
    'danger-ghost': '',
    danger: 'disabled:border disabled:border-(--button-disabled-border) disabled:bg-(--button-disabled-bg) aria-disabled:border aria-disabled:border-(--button-disabled-border) aria-disabled:bg-(--button-disabled-bg)',
};

const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
    sm: 'min-h-8 gap-1.5 px-3 text-sm',
    md: 'min-h-10 gap-2 px-4 text-sm',
};

/** Shared by `Button` and `IconButton` so both look and behave the same. */
export function buttonClassName(variant: ButtonVariant, size: ButtonSize, className?: string): string {
    return cx(
        'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-(--button-radius) font-medium whitespace-nowrap select-none',
        // Not `transition-colors`: it includes outline-color, so the focus ring would fade in from the text colour.
        'motion-safe:transition-[color,background-color,border-color] motion-safe:duration-(--motion-state) motion-safe:ease-standard',
        'aria-busy:cursor-progress',
        VARIANT_CLASSES[variant],
        'disabled:cursor-not-allowed disabled:text-(--button-disabled-text) aria-disabled:cursor-not-allowed aria-disabled:text-(--button-disabled-text)',
        DISABLED_CLASSES[variant],
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
    const reason = useTooltip(disabledReason ?? '');
    if (hidden) return null;
    const softDisabled = disabled && disabledReason !== undefined;
    const blocked = loading || softDisabled;
    const describedBy =
        cx(rest['aria-describedby'], softDisabled && reason.triggerProps['aria-describedby']) || undefined;
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
        if (blocked) {
            event.preventDefault();
            // A tap has no hover: it shows the reason instead of doing nothing.
            if (softDisabled) reason.show(event.currentTarget);
            return;
        }
        onClick?.(event);
    };
    return (
        <>
            <button
                {...rest}
                {...(softDisabled ? mergeTooltipHandlers(rest, reason.triggerProps) : {})}
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
            {softDisabled ? reason.tooltip : null}
        </>
    );
}
