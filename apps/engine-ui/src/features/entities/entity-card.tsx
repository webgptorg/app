import type { ReactNode } from 'react';

/** The common frame of an entity's hovercard: what it is, then facts, then the one way in. */
export function EntityCard({
    leading,
    title,
    meta,
    children,
    action,
}: {
    readonly leading: ReactNode;
    readonly title: string;
    /** One quiet line under the title: its state or kind. */
    readonly meta?: ReactNode;
    readonly children?: ReactNode;
    readonly action?: ReactNode;
}) {
    return (
        <span className="flex w-72 max-w-full flex-col gap-2.5 text-sm">
            <span className="flex items-start gap-2.5">
                <span className="mt-0.5 flex shrink-0 [&_svg]:size-4 [&_svg]:text-text-muted">{leading}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium [overflow-wrap:anywhere]">{title}</span>
                    {meta === undefined ? null : (
                        <span className="flex flex-wrap items-center gap-x-2 text-xs text-text-muted">{meta}</span>
                    )}
                </span>
            </span>
            {children}
            {action === undefined ? null : <span className="flex flex-wrap gap-2">{action}</span>}
        </span>
    );
}
