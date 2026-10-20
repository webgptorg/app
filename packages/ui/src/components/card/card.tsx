import { useId } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../internal/cx';

export interface CardProps {
    readonly as?: 'section' | 'article' | 'div';
    /** Rendered as a heading that also names the card. */
    readonly title?: string;
    readonly titleLevel?: 2 | 3;
    readonly actions?: ReactNode;
    readonly className?: string;
    readonly children: ReactNode;
}

export function Card({ as: Element = 'section', title, titleLevel = 2, actions, className, children }: CardProps) {
    const titleId = useId();
    const Heading = titleLevel === 2 ? 'h2' : 'h3';
    return (
        <Element
            aria-labelledby={title === undefined ? undefined : titleId}
            className={cx(
                'flex flex-col gap-4 rounded-(--card-radius) border border-(--card-border) bg-(--card-bg) p-5 shadow-(--card-shadow)',
                className,
            )}
        >
            {title === undefined && actions === undefined ? null : (
                <header className="flex flex-wrap items-center justify-between gap-3">
                    {title === undefined ? null : (
                        <Heading id={titleId} className="text-lg font-semibold text-(--card-title)">
                            {title}
                        </Heading>
                    )}
                    {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
                </header>
            )}
            {children}
        </Element>
    );
}
