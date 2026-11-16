import { CopyButton, STATUS_TINT_CLASSES, useUiMessages } from '@ptbk/ui';
import { CircleAlert, ExternalLink as ExternalLinkIcon, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';

export interface HashValueProps {
    /** A hash, UUID or signature: shown on one line, cut short, and copied whole. */
    readonly value: string;
    readonly copyLabel: string;
}

/**
 * A long machine value as one quiet mono line with a copy button. The whole value stays in the document (and in the
 * hover title), so find-in-page and screen readers still reach it; only the eye is spared a wide slab of digits.
 */
export function HashValue({ value, copyLabel }: HashValueProps) {
    return (
        <span className="flex min-w-0 items-center gap-1">
            <code title={value} className="max-w-[34ch] min-w-0 truncate font-mono text-xs text-text-muted">
                {value}
            </code>
            <CopyButton value={value} label={copyLabel} className="shrink-0" />
        </span>
    );
}

function httpUrl(href: string): URL | undefined {
    try {
        const url = new URL(href);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
    } catch {
        return undefined;
    }
}

/**
 * A way out to a public service (Rekor, the trust page) as a small pill, so it reads as "go and check it yourself"
 * rather than as prose. The same guarantees as `ExternalLink`: a new tab without access to this page, and anything but
 * an absolute http(s) URL is plain text.
 */
export function ExternalChip({ href, children }: { readonly href: string; readonly children: ReactNode }) {
    const messages = useUiMessages();
    const url = httpUrl(href);
    if (url === undefined) return <span>{children}</span>;
    return (
        <a
            href={url.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cx(
                'inline-flex h-6 max-w-full items-center gap-1.5 rounded-pill bg-neutral-soft px-2.5 text-xs font-medium text-text',
                'hover:bg-[color-mix(in_oklab,var(--color-text)_12%,var(--color-neutral-soft))]',
                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
            )}
        >
            <span className="truncate">{children}</span>
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-text-muted" />
            <span className="sr-only">{` ${messages.opensInNewTab()}`}</span>
        </a>
    );
}

/**
 * Something in a check that needs a look, on a soft surface of its state's colour. The check row above it already
 * carries the verdict, and the row opens on its own, so this explains rather than interrupts: no `alert` role.
 */
export function SecurityNote({
    tone,
    children,
}: {
    readonly tone: 'warning' | 'danger';
    readonly children: ReactNode;
}) {
    const Icon = tone === 'danger' ? CircleAlert : TriangleAlert;
    return (
        <div className={cx('soft-surface flex items-start gap-2.5 px-3.5 py-3 text-sm', STATUS_TINT_CLASSES[tone])}>
            <Icon
                aria-hidden
                className={cx('mt-0.5 size-4 shrink-0', tone === 'danger' ? 'text-danger' : 'text-warning')}
            />
            <div className="min-w-0 flex-1 break-words">{children}</div>
        </div>
    );
}

export interface CredentialRowProps {
    /** A lucide glyph for the kind of device or key. */
    readonly icon: ReactNode;
    readonly name: ReactNode;
    /** "This device", "Signed in with this one": the one the member is using now. */
    readonly current?: ReactNode;
    /** One quiet line of facts, with times in tabular figures. */
    readonly meta: ReactNode;
    readonly action?: ReactNode;
}

/** A passkey or a session as one hairline row: what it is at a glance, the facts beside it, the ⋯ menu at the end. */
export function CredentialRow({ icon, name, current, meta, action }: CredentialRowProps) {
    return (
        <li className="flex items-center gap-3 py-2.5">
            <span
                aria-hidden
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-control bg-neutral-soft text-text-muted [&>svg]:size-4"
            >
                {icon}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    {/* Names come from members and browsers: text nodes only. */}
                    <span className="min-w-0 truncate text-sm font-medium">{name}</span>
                    {current}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-text-muted tabular-nums">
                    {meta}
                </span>
            </span>
            {action === undefined ? null : <span className="shrink-0">{action}</span>}
        </li>
    );
}

/** The `·` between facts on a meta line, hidden from screen readers, which pause at the gap anyway. */
export function MetaDot() {
    return (
        <span aria-hidden className="text-text-subtle">
            ·
        </span>
    );
}
