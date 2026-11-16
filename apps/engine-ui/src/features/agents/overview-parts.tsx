import { Button, RelativeTime, Section, Skeleton } from '@ptbk/ui';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';

/**
 * The parts every agent overview section is built from, whichever feature registers it: a `Section` (heading, quiet
 * "All …" link, hairline above), table-like rows with chips, and one quiet line while loading or after a failure. A
 * section with nothing to say renders nothing, so a new agent's overview is short instead of a stack of empty cards.
 */
export function OverviewSection({
    title,
    count,
    all,
    children,
}: {
    readonly title: string;
    readonly count?: number | undefined;
    /** The way to the full list: a quiet standalone link (`overviewLinkClassName`). */
    readonly all?: ReactNode;
    readonly children: ReactNode;
}) {
    return (
        <Section title={title} {...(count === undefined ? {} : { count })} actions={all}>
            {children}
        </Section>
    );
}

/** For the section's "All …" link, as Home's "All chats". */
export const overviewLinkClassName = 'text-xs text-text-muted';

export function OverviewRows({ children, label }: { readonly children: ReactNode; readonly label?: string }) {
    return (
        <ul aria-label={label} className="flex flex-col divide-y divide-hairline">
            {children}
        </ul>
    );
}

/**
 * One thing as a table-like row, as Task detail's relations draw them: a lead (type icon or avatar), chips and state
 * in the middle, and when it last changed at the end in tabular figures. On a phone the middle wraps.
 */
export function OverviewRow({
    lead,
    children,
    at,
    end,
}: {
    readonly lead: ReactNode;
    readonly children: ReactNode;
    readonly at?: string | null | undefined;
    /** Instead of the time, e.g. "All agents" on an engine-wide integration. */
    readonly end?: ReactNode;
}) {
    return (
        <li className="grid min-h-10 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3 py-2 sm:items-center">
            <span className="flex h-6 items-center justify-center text-text-muted [&>svg]:size-4">{lead}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">{children}</span>
            <span className="flex h-6 min-w-20 items-center justify-end text-xs whitespace-nowrap text-text-muted tabular-nums">
                {end ?? (at === undefined || at === null ? null : <RelativeTime value={new Date(at)} />)}
            </span>
        </li>
    );
}

/** Shaped like the rows it stands for, so the section gives way without a jump. */
export function OverviewLoading({ label, rows = 3 }: { readonly label: string; readonly rows?: number }) {
    return (
        <div aria-busy="true" aria-label={label} className="flex flex-col gap-2">
            {Array.from({ length: rows }, (_, index) => (
                <Skeleton key={index} shape="text" className="h-6 w-full" />
            ))}
        </div>
    );
}

/** A failed section as one quiet line with its retry; the rest of the overview stays. */
export function OverviewFailed({
    message,
    onRetry,
    retrying = false,
}: {
    readonly message: string;
    readonly onRetry: () => void;
    readonly retrying?: boolean;
}) {
    return (
        <p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted">
            <span>{message}</span>
            <Button variant="ghost" size="sm" loading={retrying} onClick={onRetry}>
                {m.ui_retry()}
            </Button>
        </p>
    );
}

/** One quiet line where the section stays on the page but has nothing in it yet. */
export function OverviewEmpty({ children }: { readonly children: ReactNode }) {
    return <p className="text-sm text-text-muted">{children}</p>;
}
