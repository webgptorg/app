import { ChevronRight } from 'lucide-react';

import { useUiMessages } from '../../i18n/ui-provider';
import { CopyButton } from '../copy-button/copy-button';

export interface TechnicalDetail {
    readonly label: string;
    /** A hash, ID or other machine value; shown on one line, cut short, and copied whole. */
    readonly value: string;
}

export interface TechnicalDetailsProps {
    readonly items: readonly TechnicalDetail[];
    /** Defaults to "Technical details". */
    readonly title?: string;
    /** Passed to each `CopyButton`; injectable for tests. */
    readonly copy?: (text: string) => Promise<void>;
}

/**
 * Hashes, IDs and other values people rarely read, collapsed under one quiet "Technical details" disclosure so they
 * stop pushing the content below the fold. Each value is one truncated line with a copy button; the full text stays
 * in the document, so screen readers and find-in-page still reach it.
 */
export function TechnicalDetails({ items, title, copy }: TechnicalDetailsProps) {
    const messages = useUiMessages();
    if (items.length === 0) return null;
    return (
        <details className="group text-sm">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-small text-(--technical-details-summary) hover:text-(--technical-details-summary-hover) [&::-webkit-details-marker]:hidden">
                <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 motion-safe:transition-transform motion-safe:duration-(--motion-state) group-open:rotate-90"
                />
                {title ?? messages.technicalDetails()}
            </summary>
            <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1">
                {items.map((item) => (
                    <div key={item.label} className="contents">
                        <dt className="text-(--technical-details-label)">{item.label}</dt>
                        <dd className="flex min-w-0 items-center gap-1">
                            <code className="min-w-0 truncate font-mono text-xs text-(--technical-details-value)">
                                {item.value}
                            </code>
                            <CopyButton
                                value={item.value}
                                label={messages.copyValue({ label: item.label })}
                                {...(copy === undefined ? {} : { copy })}
                            />
                        </dd>
                    </div>
                ))}
            </dl>
        </details>
    );
}
