import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';

import { CONTROL_HEIGHT, TOUCH_HEIGHT } from '../../internal/control';
import { cx } from '../../internal/cx';
import { mergeTooltipHandlers, useTooltip } from '../tooltip/tooltip';
import { Spinner } from '../spinner/spinner';

/**
 * Every button is soft: a text-coloured label on a quiet wash or a hairline, never an inverted fill. `primary` is the
 * main action (a stronger wash, medium weight); `secondary` has the hairline only; `ghost` neither. `danger` is a soft
 * red wash for a destructive action in place; `danger-ghost` is one that is not the point of the screen.
 * `danger-solid`, the one filled button, is only the confirm step that names what it destroys (ConfirmDialog).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'danger-solid';
export type ButtonSize = 'sm' | 'md' | 'lg';

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
        'border border-(--button-primary-border) bg-(--button-primary-bg) font-medium text-(--button-primary-text) hover:enabled:not-aria-disabled:bg-(--button-primary-bg-hover) active:enabled:not-aria-disabled:bg-(--button-primary-bg-active)',
    secondary:
        'border border-(--button-secondary-border) bg-transparent text-(--button-secondary-text) hover:enabled:not-aria-disabled:bg-(--button-secondary-bg-hover) active:enabled:not-aria-disabled:bg-(--button-secondary-bg-active)',
    ghost: 'bg-transparent text-(--button-ghost-text) hover:enabled:not-aria-disabled:bg-(--button-ghost-bg-hover) active:enabled:not-aria-disabled:bg-(--button-ghost-bg-active)',
    danger: 'border border-(--button-danger-border) bg-(--button-danger-bg) font-medium text-(--button-danger-text) hover:enabled:not-aria-disabled:bg-(--button-danger-bg-hover) active:enabled:not-aria-disabled:bg-(--button-danger-bg-active)',
    'danger-ghost':
        'bg-transparent text-(--button-danger-ghost-text) hover:enabled:not-aria-disabled:bg-(--button-danger-ghost-bg-hover) active:enabled:not-aria-disabled:bg-(--button-danger-ghost-bg-active)',
    'danger-solid':
        'bg-(--button-danger-solid-bg) font-medium text-(--button-danger-solid-text) hover:enabled:not-aria-disabled:bg-(--button-danger-solid-bg-hover)',
};

/**
 * Inert in both themes through its own tokens, not opacity: no wash, a hairline and muted text, so a disabled button
 * never reads as live. Ghost buttons keep no frame at all.
 */
const FRAMED_DISABLED =
    'disabled:border-(--button-disabled-border) disabled:bg-transparent aria-disabled:border-(--button-disabled-border) aria-disabled:bg-transparent';
const DISABLED_CLASSES: Readonly<Record<ButtonVariant, string>> = {
    primary: FRAMED_DISABLED,
    secondary: FRAMED_DISABLED,
    danger: FRAMED_DISABLED,
    ghost: '',
    'danger-ghost': '',
    'danger-solid': `border border-transparent ${FRAMED_DISABLED}`,
};

const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
    sm: cx(CONTROL_HEIGHT.sm, TOUCH_HEIGHT.sm, 'gap-1.5 px-2.5 text-xs'),
    md: cx(CONTROL_HEIGHT.md, TOUCH_HEIGHT.md, 'gap-2 px-3.5 text-sm'),
    // The one action of a page with nothing else to do (sign in with a passkey); never on a line with other controls.
    lg: 'min-h-11 gap-2 px-5 text-sm',
};

/** Shared by `Button` and `IconButton` so both look and behave the same. */
export function buttonClassName(variant: ButtonVariant, size: ButtonSize, className?: string): string {
    return cx(
        'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-(--button-radius) whitespace-nowrap select-none',
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
