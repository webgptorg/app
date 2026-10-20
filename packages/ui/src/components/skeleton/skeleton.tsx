import { cx } from '../../internal/cx';

export interface SkeletonProps {
    readonly shape?: 'text' | 'block' | 'circle';
    /** Sizing utilities matching the content it stands in for, so nothing shifts when that content arrives. */
    readonly className?: string;
}

const SHAPE_CLASSES = {
    text: 'h-4 w-full rounded-small',
    block: 'h-24 w-full rounded-control',
    circle: 'size-10 shrink-0 rounded-pill',
} as const;

/**
 * A placeholder of fixed size, hidden from assistive technology; the container it fills sets `aria-busy` and the
 * loading announcement.
 */
export function Skeleton({ shape = 'text', className }: SkeletonProps) {
    return (
        <span
            aria-hidden="true"
            className={cx(
                'block max-w-full bg-(--skeleton-bg) motion-safe:animate-[ptbk-skeleton-pulse_var(--skeleton-period)_var(--ease-standard)_infinite]',
                SHAPE_CLASSES[shape],
                className,
            )}
        />
    );
}
