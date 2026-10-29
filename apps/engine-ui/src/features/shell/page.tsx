import type { Anchor } from '@ptbk/ui';
import type { LinkComponent } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { Link } from '../../app/link';
import { useDocumentTitle } from './document-title';

export interface PageProps {
    readonly title: string;
    /** One quiet line under the title saying what the screen is for. */
    readonly description?: ReactNode;
    /** A way back to the list this screen belongs to, above the title: a `BackLink`. */
    readonly back?: ReactNode;
    /**
     * The browser tab's title before the engine name, most specific first; defaults to `title`. Add where the page
     * lives when the title alone is ambiguous, e.g. `[trigger.name, 'Triggers']`.
     */
    readonly documentTitle?: readonly string[];
    readonly actions?: ReactNode;
    readonly children: ReactNode;
}

/** The frame of every routed screen: one `h1` (the skip link and route announcements land on it) and the content. */
export function Page({ title, description, back, documentTitle, actions, children }: PageProps) {
    useDocumentTitle(...(documentTitle ?? [title]));
    return (
        <section
            aria-labelledby="page-title"
            aria-describedby={description === undefined ? undefined : 'page-description'}
            className="flex flex-col gap-6"
        >
            <header className="flex flex-col gap-3">
                {back === undefined ? null : <div className="flex">{back}</div>}
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                        <h1 id="page-title" className="text-2xl font-semibold break-words">
                            {title}
                        </h1>
                        {description === undefined ? null : (
                            <p id="page-description" className="max-w-prose text-sm text-text-muted">
                                {description}
                            </p>
                        )}
                    </div>
                    {actions}
                </div>
            </header>
            {children}
        </section>
    );
}

/**
 * The one way back from a detail or form page to its list ("Back to runs"), placed by `Page` above the title. Name
 * where it leads, including the context the user came from ("Back to Ada's runs").
 */
export const BackLink: LinkComponent<typeof Anchor> = ({ children, ...link }) => (
    <Link {...link} variant="standalone" className="inline-flex items-center gap-1 text-sm">
        {(state) => (
            <>
                <ArrowLeft aria-hidden className="size-4" />
                {typeof children === 'function' ? children(state) : children}
            </>
        )}
    </Link>
);
