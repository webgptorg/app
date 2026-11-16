import type { ReactNode } from 'react';

import { cx } from '../../internal/cx';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
    readonly tone?: BadgeTone;
    /** Decorative; the text carries the meaning, so status is never colour-only. */
    readonly icon?: ReactNode;
    readonly className?: string;
    readonly children: ReactNode;
}

const TONE_CLASSES: Readonly<Record<BadgeTone, string>> = {
    neutral: 'bg-(--badge-neutral-bg) text-(--badge-neutral-text)',
    accent: 'bg-(--badge-accent-bg) text-(--badge-accent-text)',
    success: 'bg-(--badge-success-bg) text-(--badge-success-text)',
    warning: 'bg-(--badge-warning-bg) text-(--badge-warning-text)',
    danger: 'bg-(--badge-danger-bg) text-(--badge-danger-text)',
    info: 'bg-(--badge-info-bg) text-(--badge-info-text)',
};

export function Badge({ tone = 'neutral', icon, className, children }: BadgeProps) {
    return (
        <span
            className={cx(
                'inline-flex max-w-full items-center gap-1 rounded-(--badge-radius) px-1.5 py-px text-2xs font-medium whitespace-nowrap',
                TONE_CLASSES[tone],
                className,
            )}
        >
            {icon === undefined ? null : (
                <span aria-hidden="true" className="inline-flex size-3.5 shrink-0 items-center">
                    {icon}
                </span>
            )}
            <span className="truncate">{children}</span>
        </span>
    );
}
