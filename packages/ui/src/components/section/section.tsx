import { useId } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../internal/cx';

export interface SectionProps {
    /** Rendered as a heading that also names the section. */
    readonly title?: string;
    readonly titleLevel?: 2 | 3;
    /** A number beside the title in tabular figures, e.g. how many tasks run now. */
    readonly count?: number;
    /** One quiet line under the title. */
    readonly description?: ReactNode;
    /** Quiet actions on the right of the heading (a ghost button, "View all"). */
    readonly actions?: ReactNode;
    /** A 1px hairline above, separating it from the section before; off for the first section of a page. */
    readonly divided?: boolean;
    readonly as?: 'section' | 'div';
    readonly className?: string;
    readonly children?: ReactNode;
}

/**
 * A heading over content, separated from its neighbours by space and a hairline: the open layout that replaces bordered
 * cards. Live or actionable things inside it may sit on a `soft-surface`; the section itself never has a fill.
 */
export function Section({
    title,
    titleLevel = 2,
    count,
    description,
    actions,
    divided = true,
    as: Element = 'section',
    className,
    children,
}: SectionProps) {
    const titleId = useId();
    const Heading = titleLevel === 2 ? 'h2' : 'h3';
    const hasHeader = title !== undefined || actions !== undefined || description !== undefined;
    return (
        <Element
            aria-labelledby={title === undefined ? undefined : titleId}
            className={cx(
                'flex min-w-0 flex-col gap-3',
                divided && 'border-t border-(--section-hairline) pt-5',
                className,
            )}
        >
            {hasHeader ? (
                <header className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <div className="flex min-w-0 flex-col gap-0.5">
                        {title === undefined ? null : (
                            <Heading className="truncate text-sm font-semibold text-(--section-title)">
                                {/* The region is named by the title alone; the heading reads "Needs you 5". */}
                                <span id={titleId}>{title}</span>
                                {count === undefined ? null : (
                                    <>
                                        {' '}
                                        <span className="ms-1 font-medium text-(--section-muted) tabular-nums">
                                            {count}
                                        </span>
                                    </>
                                )}
                            </Heading>
                        )}
                        {description === undefined ? null : (
                            <p className="text-xs text-(--section-muted)">{description}</p>
                        )}
                    </div>
                    {actions === undefined ? null : <div className="flex items-center gap-1">{actions}</div>}
                </header>
            ) : null}
            {children}
        </Element>
    );
}
