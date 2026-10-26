import { cx } from '../../internal/cx';

export interface MonogramProps {
    /** The person or thing it stands for; only its first letter is drawn. */
    readonly name: string;
    readonly className?: string;
}

/**
 * A decorative initial, as in an avatar. The letter is CSS generated content rather than text, so it is never part of
 * the visible label of the button or link around it: WCAG 2.5.3 (axe `label-content-name-mismatch`) wants a
 * control's visible text inside its accessible name, and a stray "A" before the name is not.
 */
export function Monogram({ name, className }: MonogramProps) {
    return (
        <span
            aria-hidden="true"
            data-initial={name.trim().charAt(0).toUpperCase()}
            className={cx(
                'inline-flex size-8 shrink-0 items-center justify-center rounded-pill bg-(--monogram-bg) font-display text-sm font-semibold text-(--monogram-text) before:content-[attr(data-initial)]',
                className,
            )}
        />
    );
}
