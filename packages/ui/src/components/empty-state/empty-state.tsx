import type { ReactNode } from 'react';

import { cx } from '../../internal/cx';

export interface EmptyStateProps {
    readonly title: string;
    readonly description?: ReactNode;
    /** A small monochrome icon (lucide); decorative. */
    readonly icon?: ReactNode;
    /**
     * A larger picture in place of the icon, for the block variant only: the brand robot (`BrandRobot`) where the app
     * speaks as Promptbook itself, such as a main list that is still empty. Decorative.
     */
    readonly illustration?: ReactNode;
    /** The one next step, e.g. a "New agent" button. */
    readonly action?: ReactNode;
    /**
     * `block` centres it where a whole view is empty; `inline` is one quiet line with the action at its end, for an
     * empty section that stays on the page.
     */
    readonly variant?: 'block' | 'inline';
    readonly className?: string;
    /** Makes the title a heading, e.g. `1` when the empty state is the whole page. */
    readonly headingLevel?: 1 | 2 | 3;
}

const HEADING_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3' } as const;

/** What a view shows when there is nothing yet: one calm line, one action and a small monochrome icon or the robot. */
export function EmptyState({
    title,
    description,
    icon,
    illustration,
    action,
    variant = 'block',
    className,
    headingLevel,
}: EmptyStateProps) {
    const Title = headingLevel === undefined ? 'p' : HEADING_TAGS[headingLevel];
    const glyph =
        icon === undefined ? null : (
            <span
                aria-hidden="true"
                className="inline-flex size-4 shrink-0 items-center justify-center text-(--empty-state-icon) [&>svg]:size-4"
            >
                {icon}
            </span>
        );
    if (variant === 'inline') {
        return (
            <div className={cx('flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm', className)}>
                {glyph}
                <Title className="text-sm font-normal text-(--empty-state-description)">{title}</Title>
                {description === undefined ? null : (
                    <p className="text-xs text-(--empty-state-description)">{description}</p>
                )}
                {action === undefined ? null : <div className="ms-auto">{action}</div>}
            </div>
        );
    }
    return (
        <div className={cx('flex flex-col items-center gap-2 px-6 py-12 text-center', className)}>
            {illustration === undefined ? (
                glyph === null ? null : (
                    <span className="mb-1 inline-flex">{glyph}</span>
                )
            ) : (
                <span aria-hidden="true" className="mb-2 inline-flex">
                    {illustration}
                </span>
            )}
            <Title className="text-sm font-medium text-(--empty-state-title)">{title}</Title>
            {description === undefined ? null : (
                <p className="max-w-prose text-sm text-(--empty-state-description)">{description}</p>
            )}
            {action === undefined ? null : <div className="mt-2">{action}</div>}
        </div>
    );
}
