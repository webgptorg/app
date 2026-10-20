import type { ReactNode } from 'react';

import { cx } from '../../internal/cx';

export interface EmptyStateProps {
    readonly title: string;
    readonly description?: ReactNode;
    /** Decorative. */
    readonly icon?: ReactNode;
    /** The next step, e.g. a "New agent" button. */
    readonly action?: ReactNode;
    readonly className?: string;
    /** Makes the title a heading, e.g. `1` when the empty state is the whole page. */
    readonly headingLevel?: 1 | 2 | 3;
}

const HEADING_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3' } as const;

/** What a view shows when there is nothing yet: what would be here and how to get it. */
export function EmptyState({ title, description, icon, action, className, headingLevel }: EmptyStateProps) {
    const Title = headingLevel === undefined ? 'p' : HEADING_TAGS[headingLevel];
    return (
        <div className={cx('flex flex-col items-center gap-3 px-6 py-10 text-center', className)}>
            {icon === undefined ? null : (
                <span
                    aria-hidden="true"
                    className="inline-flex size-12 items-center justify-center rounded-pill bg-(--empty-state-icon-bg) text-(--empty-state-icon)"
                >
                    {icon}
                </span>
            )}
            <Title className="font-display text-lg font-semibold text-(--empty-state-title)">{title}</Title>
            {description === undefined ? null : (
                <p className="max-w-prose text-sm text-(--empty-state-description)">{description}</p>
            )}
            {action === undefined ? null : <div className="mt-2">{action}</div>}
        </div>
    );
}
