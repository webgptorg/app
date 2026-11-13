import type { ReactNode } from 'react';

import { cx } from '../../internal/cx';

/**
 * How loud a state is. `live` is work running now (it breathes), `waiting` is queued or scheduled, `warning` needs
 * someone, `danger` failed or is blocked, `success` is done, `neutral` is stopped, retired or unknown.
 */
export type StatusTone = 'live' | 'waiting' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const DOT_CLASSES: Readonly<Record<StatusTone, string>> = {
    live: 'bg-(--status-live) motion-safe:animate-breathe',
    // A ring rather than a disc: not started yet, so it reads differently from done even without colour.
    waiting: 'border-[1.5px] border-(--status-waiting)',
    success: 'bg-(--status-success)',
    warning: 'bg-(--status-warning)',
    danger: 'bg-(--status-danger)',
    info: 'bg-(--status-info)',
    neutral: 'bg-(--status-neutral)',
};

/** `--tint` for the tone, for a `soft-surface` or a pill wash. */
export const STATUS_TINT_CLASSES: Readonly<Record<StatusTone, string>> = {
    live: '[--tint:var(--status-live)]',
    waiting: '[--tint:var(--status-waiting)]',
    success: '[--tint:var(--status-success)]',
    warning: '[--tint:var(--status-warning)]',
    danger: '[--tint:var(--status-danger)]',
    info: '[--tint:var(--status-info)]',
    neutral: '[--tint:var(--status-neutral)]',
};

export interface StatusDotProps {
    readonly tone: StatusTone;
    /** Read to screen readers instead of hiding the dot; leave it out when a visible label sits beside the dot. */
    readonly label?: string;
    readonly className?: string;
}

/** A small status dot. Decorative unless it gets a `label`, so state is never colour alone. */
export function StatusDot({ tone, label, className }: StatusDotProps) {
    return (
        <span
            {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
            className={cx('inline-block size-2 shrink-0 rounded-pill', DOT_CLASSES[tone], className)}
        />
    );
}

export interface StatusPillProps {
    readonly tone: StatusTone;
    /** The state in words. */
    readonly children: ReactNode;
    /** `quiet` drops the wash: a dot and a label, for dense rows. */
    readonly variant?: 'soft' | 'quiet';
    readonly className?: string;
}

/**
 * A state as a dot and words on a faint wash of its hue. The text stays in the text colour, so the pill is calm in both
 * themes and readable on any surface; the hue lives only in the dot and the wash.
 */
export function StatusPill({ tone, children, variant = 'soft', className }: StatusPillProps) {
    return (
        <span
            className={cx(
                'inline-flex max-w-full items-center gap-1.5 text-xs font-medium whitespace-nowrap text-(--status-pill-text)',
                variant === 'soft' &&
                    'rounded-(--status-pill-radius) bg-[color-mix(in_oklab,var(--tint)_var(--status-pill-wash),transparent)] px-2 py-0.5',
                STATUS_TINT_CLASSES[tone],
                className,
            )}
        >
            <StatusDot tone={tone} />
            <span className="truncate">{children}</span>
        </span>
    );
}
