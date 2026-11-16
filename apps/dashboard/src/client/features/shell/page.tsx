import { createLink } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';

import { m } from '../../../paraglide/messages';

export interface PageProps {
    readonly title: ReactNode;
    /** Something that identifies the page's subject beside the title, e.g. an engine's fingerprint mark. */
    readonly leading?: ReactNode;
    /** One quiet line under the title saying what the screen is for. */
    readonly description?: ReactNode;
    /** Where the screen sits, outermost first, as `Crumb` links. They replace "Back to …" links. */
    readonly breadcrumbs?: readonly ReactNode[];
    /** The primary action and quiet extras (a ⋯ menu), right of the title. */
    readonly actions?: ReactNode;
    /** `narrow` for single-task screens (linking an engine), so lines keep a readable measure. */
    readonly width?: 'full' | 'narrow';
    readonly children: ReactNode;
}

/**
 * The frame of every signed-in screen: a slim header (where it is, the one `h1`, the primary action), then the content
 * as open sections. Same pattern as the engine UI's `Page`, without its sticky bar: dashboard pages are short.
 */
export function Page({ title, leading, description, breadcrumbs, actions, width = 'full', children }: PageProps) {
    const trail = breadcrumbs ?? [];
    return (
        <div className={`flex flex-col gap-6 ${width === 'narrow' ? 'max-w-2xl' : ''}`}>
            <header className="flex flex-col gap-1">
                {trail.length === 0 ? null : (
                    <nav aria-label={m.breadcrumbs()} className="min-w-0">
                        <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-text-muted">
                            {trail.map((crumb, index) => (
                                <Fragment key={index}>
                                    <li className="flex min-w-0 items-center">{crumb}</li>
                                    <li aria-hidden="true" className="flex items-center">
                                        <ChevronRight className="size-3.5 opacity-70" />
                                    </li>
                                </Fragment>
                            ))}
                        </ol>
                    </nav>
                )}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <div className="flex min-w-0 items-center gap-3">
                        {leading}
                        <h1 className="min-w-0 text-xl font-semibold tracking-display [overflow-wrap:anywhere]">
                            {title}
                        </h1>
                    </div>
                    {actions === undefined ? null : (
                        <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
                    )}
                </div>
                {description === undefined ? null : (
                    <p className="max-w-prose text-sm text-text-muted">{description}</p>
                )}
            </header>
            {children}
        </div>
    );
}

// A plain `<a>`: `Anchor`'s accent colour and hover underline are what a quiet trail must not have. The router marks a
// parent route's link as current on its children ("Engines" on /engines/new), but a crumb is never the page itself.
function CrumbAnchor({ className, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
    return (
        <a
            {...rest}
            aria-current={undefined}
            className={`truncate rounded-small text-text-muted hover:text-text motion-safe:transition-colors motion-safe:duration-(--motion-state) ${className ?? ''}`}
        >
            {children}
        </a>
    );
}

/** One step of a page's breadcrumb trail: a quiet link to a screen above this one. */
export const Crumb = createLink(CrumbAnchor);
