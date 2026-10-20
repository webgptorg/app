import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';

export interface SpinnerProps {
    readonly size?: 'sm' | 'md';
    /** `current` takes the surrounding text colour, e.g. inside a button. */
    readonly tone?: 'accent' | 'current';
    /** Announces "Loading" with `role="status"`; set false when the container already says it is busy. */
    readonly announce?: boolean;
    readonly className?: string;
}

/** For short waits with no layout to hold; where content will appear, a `Skeleton` fits better. */
export function Spinner({ size = 'md', tone = 'accent', announce = true, className }: SpinnerProps) {
    const messages = useUiMessages();
    const circle = (
        <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={cx(
                'shrink-0 motion-safe:animate-[ptbk-spin_var(--spinner-period)_linear_infinite]',
                tone === 'accent' ? 'text-(--spinner-color)' : 'text-current',
                size === 'sm' ? 'size-4' : 'size-6',
                className,
            )}
        >
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
    );
    if (!announce) return circle;
    return (
        <span role="status" className="inline-flex items-center">
            {circle}
            <span className="sr-only">{messages.loading()}</span>
        </span>
    );
}
