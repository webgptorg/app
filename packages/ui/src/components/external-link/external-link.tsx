import { ExternalLink as ExternalLinkIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';

export interface ExternalLinkProps {
    readonly href: string;
    readonly children: ReactNode;
    /** Shows the destination host next to the text, so users see where they are going before they click. */
    readonly showHost?: boolean;
    readonly className?: string;
}

function parseHttpUrl(href: string): URL | undefined {
    try {
        const url = new URL(href);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
    } catch {
        return undefined;
    }
}

/**
 * A link to another origin, opened in a new tab without access to this page (`noopener noreferrer`). Anything but an
 * absolute http(s) URL, such as `javascript:` from untrusted data, renders as plain text instead of a link.
 */
export function ExternalLink({ href, children, showHost = true, className }: ExternalLinkProps) {
    const messages = useUiMessages();
    const url = parseHttpUrl(href);
    if (url === undefined) return <span className={className}>{children}</span>;
    return (
        <a
            href={url.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cx(
                'inline-flex items-baseline gap-1 rounded-small text-(--anchor-text) underline underline-offset-2 hover:text-(--anchor-text-hover)',
                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                className,
            )}
        >
            {children}
            {showHost ? <span className="text-(--external-link-host) no-underline">{`(${url.host})`}</span> : null}
            <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0 self-center" />
            <span className="sr-only">{` ${messages.opensInNewTab()}`}</span>
        </a>
    );
}
