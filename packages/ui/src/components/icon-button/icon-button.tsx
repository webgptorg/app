import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from 'react';

import { cx } from '../../internal/cx';
import { mergeTooltipHandlers, useTooltip } from '../tooltip/tooltip';
import { buttonClassName } from '../button/button';
import type { ButtonSize, ButtonVariant } from '../button/button';
import { Spinner } from '../spinner/spinner';

export interface IconButtonProps extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'disabled' | 'children' | 'aria-label'
> {
    /** The accessible name; an icon alone says nothing to a screen reader, so it is required. */
    readonly label: string;
    readonly icon: ReactNode;
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
    readonly loading?: boolean;
    readonly disabled?: boolean;
    /** Why a disabled action is unavailable; keeps the button focusable with `aria-disabled` (see `Button`). */
    readonly disabledReason?: string;
    readonly hidden?: boolean;
    readonly ref?: Ref<HTMLButtonElement>;
}

const SQUARE: Readonly<Record<ButtonSize, string>> = {
    sm: 'size-8 px-0',
    md: 'size-10 px-0',
    lg: 'size-11 px-0',
};

export function IconButton({
    label,
    icon,
    variant = 'ghost',
    size = 'md',
    loading = false,
    disabled = false,
    disabledReason,
    hidden = false,
    type = 'button',
    className,
    onClick,
    ...rest
}: IconButtonProps) {
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
                aria-label={label}
                className={buttonClassName(variant, size, cx(SQUARE[size], className))}
                disabled={disabled && !softDisabled}
                aria-disabled={softDisabled || undefined}
                aria-busy={loading || undefined}
                aria-describedby={describedBy}
                onClick={handleClick}
            >
                {loading ? (
                    <Spinner size="sm" tone="current" announce={false} />
                ) : (
                    <span aria-hidden="true" className="inline-flex size-4 items-center justify-center">
                        {icon}
                    </span>
                )}
            </button>
            {softDisabled ? reason.tooltip : null}
        </>
    );
}
