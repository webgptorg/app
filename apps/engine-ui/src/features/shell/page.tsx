import { Anchor } from '@ptbk/ui';
import type { AnchorProps } from '@ptbk/ui';
import { createLink } from '@tanstack/react-router';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Fragment } from 'react';
import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { useDocumentTitle } from './document-title';

export interface PageProps {
    readonly title: string;
    /** Quiet text after the title in the same heading, e.g. a timestamp that is part of an engine name. */
    readonly titleSuffix?: ReactNode | undefined;
    /** One quiet line under the title saying what the screen is for. */
    readonly description?: ReactNode;
    /**
     * Where the screen sits, outermost first, as `Crumb` links ("Tasks" on a task). They replace "Back to …" links:
     * the trail is the way back.
     */
    readonly breadcrumbs?: readonly ReactNode[] | undefined;
    /** A way back to the list this screen belongs to: a `BackLink`. Screens with `breadcrumbs` leave it out. */
    readonly back?: ReactNode | undefined;
    /**
     * The browser tab's title before the engine name, most specific first; defaults to `title`. Add where the page
     * lives when the title alone is ambiguous, e.g. `[trigger.name, 'Triggers']`.
     */
    readonly documentTitle?: readonly string[];
    readonly actions?: ReactNode | undefined;
    /** CSSOM style for the title's text, e.g. the `view-transition-name` a list row's title morphs into. */
    readonly titleStyle?: CSSProperties | undefined;
    /**
     * `wide` (the default) uses the screen, for lists, tables and detail pages; `reading` keeps a form or prose at a
     * comfortable line length.
     */
    readonly width?: 'wide' | 'reading';
    readonly children: ReactNode;
}

/**
 * The frame of every routed screen: a slim header that stays in view while the page scrolls (where it is, the one
 * `h1` the skip link and route announcements land on, the primary action), then the content.
 */
export function Page({
    title,
    titleSuffix,
    description,
    breadcrumbs,
    back,
    documentTitle,
    actions,
    titleStyle,
    width = 'wide',
    children,
}: PageProps) {
    useDocumentTitle(...(documentTitle ?? [title]));
    return (
        <section
            aria-labelledby="page-title"
            aria-describedby={description === undefined ? undefined : 'page-description'}
            className={cx('flex flex-col gap-6', width === 'reading' && 'max-w-3xl')}
        >
            <PageHeader
                title={title}
                titleSuffix={titleSuffix}
                breadcrumbs={breadcrumbs}
                back={back}
                actions={actions}
                titleStyle={titleStyle}
            />
            {description === undefined ? null : (
                <p id="page-description" className="-mt-5 max-w-prose text-sm text-text-muted">
                    {description}
                </p>
            )}
            {children}
        </section>
    );
}

type PageHeaderProps = Pick<PageProps, 'title' | 'titleSuffix' | 'breadcrumbs' | 'back' | 'actions' | 'titleStyle'>;

/**
 * The sticky bar itself. On narrow screens it scrolls away with the page: the phone's own top bar already stays, and
 * two stuck bars would eat the screen.
 */
export function PageHeader({ title, titleSuffix, breadcrumbs, back, actions, titleStyle }: PageHeaderProps) {
    const trail = breadcrumbs ?? [];
    return (
        <header
            data-page-header=""
            className={cx(
                'z-10 -mx-4 flex flex-col gap-1 px-4 py-3 md:sticky md:top-0 md:-mx-8 md:px-8',
                'bg-[color-mix(in_oklab,var(--color-surface)_88%,transparent)] backdrop-blur-md',
            )}
        >
            <Breadcrumbs trail={trail} />
            {back === undefined ? null : <div className="flex">{back}</div>}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h1 id="page-title" className="min-w-0 text-xl font-semibold tracking-display [overflow-wrap:anywhere]">
                    {titleStyle === undefined ? title : <span style={titleStyle}>{title}</span>}
                    {/* A real space, so the heading's accessible name does not run the two together. */}
                    {titleSuffix === undefined ? null : ' '}
                    {titleSuffix === undefined ? null : (
                        <span className="ms-1 text-sm font-normal tracking-normal text-text-muted tabular-nums">
                            {titleSuffix}
                        </span>
                    )}
                </h1>
                {actions === undefined ? null : (
                    <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
                )}
            </div>
        </header>
    );
}

/** Where a screen sits, outermost first, as `Crumb` links; nothing for a top-level screen. */
export function Breadcrumbs({ trail }: { readonly trail: readonly ReactNode[] }) {
    if (trail.length === 0) return null;
    return (
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
    );
}

// A plain `<a>`: `Anchor`'s accent colour and hover underline are what a quiet trail must not have.
function CrumbAnchor({ className, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
    return (
        <a
            {...rest}
            className={cx(
                'truncate rounded-small text-text-muted hover:text-text',
                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                className,
            )}
        >
            {children}
        </a>
    );
}

/** One step of a page's breadcrumb trail: a quiet link to a screen above this one. */
export const Crumb = createLink(CrumbAnchor);

function BackAnchor({ children, ...rest }: AnchorProps) {
    return (
        <Anchor {...rest} variant="standalone" className="inline-flex items-center gap-1 text-sm">
            <ArrowLeft aria-hidden className="size-4" />
            {children}
        </Anchor>
    );
}

/**
 * A way back from a detail or form page to its list ("Back to runs"), placed by `Page` above the title. Name where
 * it leads, including the context the member came from ("Back to Ada's runs"). New screens use `breadcrumbs`.
 */
export const BackLink = createLink(BackAnchor);
