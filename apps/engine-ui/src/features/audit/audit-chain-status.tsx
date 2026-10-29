import { Banner, Button, Skeleton, useLocale } from '@ptbk/ui';
import { CircleCheck } from 'lucide-react';
import { useId, useState } from 'react';

import { m } from '../../paraglide/messages';
import { useAuditChainStatus } from './audit-queries';

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "3:58 PM" for a check made today, with the date for an older one. */
function checkedTime(locale: string, checkedAt: Date): string {
    const options: Intl.DateTimeFormatOptions = sameDay(checkedAt, new Date())
        ? { timeStyle: 'short' }
        : { dateStyle: 'medium', timeStyle: 'short' };
    return new Intl.DateTimeFormat(locale, options).format(checkedAt);
}

/**
 * The engine's latest verdict on the hash chain; the UI reports it and never re-verifies (U-07, Risks). An intact
 * chain is the normal case, so it is one quiet line with the details on hover or click; only a broken chain or a
 * failed check gets a banner.
 */
export function AuditChainStatus() {
    const status = useAuditChainStatus();
    if (status.isPending) return <Skeleton className="h-5 w-48" />;
    if (status.isError) {
        return (
            <Banner
                tone="warning"
                action={
                    <Button
                        size="sm"
                        loading={status.isFetching}
                        onClick={() => {
                            void status.refetch();
                        }}
                    >
                        {m.audit_retry()}
                    </Button>
                }
            >
                {m.audit_chain_failed()}
            </Banner>
        );
    }
    const { status: verdict, checkedAt, checkedEntries, firstBrokenSeq } = status.data;
    if (verdict === 'broken') return <BrokenChain checkedAt={checkedAt} firstBrokenSeq={firstBrokenSeq} />;
    // With nothing logged yet there is nothing to vouch for; the empty log says so.
    if (checkedEntries === 0) return null;
    return <IntactChain checkedAt={checkedAt} checkedEntries={checkedEntries} />;
}

function BrokenChain({
    checkedAt,
    firstBrokenSeq,
}: {
    readonly checkedAt: string;
    readonly firstBrokenSeq: number | null;
}) {
    const locale = useLocale();
    return (
        <Banner tone="danger" title={m.audit_chain_broken_title()}>
            {m.audit_chain_broken_body({
                seq: String(firstBrokenSeq ?? '?'),
                at: locale.formatDateTime(new Date(checkedAt)),
            })}
        </Banner>
    );
}

function IntactChain({ checkedAt, checkedEntries }: { readonly checkedAt: string; readonly checkedEntries: number }) {
    const locale = useLocale();
    const detailsId = useId();
    const [open, setOpen] = useState(false);
    const checked = new Date(checkedAt);
    const details = m.audit_chain_intact_details({
        count: checkedEntries,
        total: locale.formatNumber(checkedEntries),
        at: locale.formatDateTime(checked),
    });
    return (
        <div className="flex flex-col items-start gap-1">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={detailsId}
                title={details}
                onClick={() => {
                    setOpen(!open);
                }}
                className="-mx-1 inline-flex min-h-6 cursor-pointer items-center gap-1.5 rounded-control px-1 text-sm text-text-muted hover:text-text"
            >
                <CircleCheck aria-hidden className="size-4 text-success" />
                {m.audit_chain_verified({ time: checkedTime(locale.locale, checked) })}
            </button>
            {open ? (
                <p id={detailsId} className="text-sm text-text-muted">
                    {details}
                </p>
            ) : null}
        </div>
    );
}
