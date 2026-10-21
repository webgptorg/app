import type { ReadAuditEntry } from '@ptbk/engine-api';
import { CodeText, useLocale } from '@ptbk/ui';

import { m } from '../../paraglide/messages';

/**
 * The expanded row. `details` comes from the engine and may hold anything a member typed, so it is shown as
 * pretty-printed JSON text, never interpreted.
 */
export function AuditEntryDetails({ entry }: { readonly entry: ReadAuditEntry }) {
    const locale = useLocale();
    const details = entry.details ?? null;
    return (
        <div className="flex min-w-0 flex-col gap-4 py-2">
            <dl className="grid min-w-0 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
                <dt className="font-medium text-text-muted">{m.audit_sequence()}</dt>
                <dd className="tabular-nums">{locale.formatNumber(entry.seq)}</dd>
                <dt className="font-medium text-text-muted">{m.audit_entry_hash()}</dt>
                <dd className="min-w-0">
                    <CodeText value={entry.hash} copyable copyLabel={m.audit_copy_hash()} />
                </dd>
                <dt className="font-medium text-text-muted">{m.audit_previous_hash()}</dt>
                <dd className="min-w-0">
                    {entry.prevHash === null ? (
                        <span className="text-text-muted">{m.audit_first_entry()}</span>
                    ) : (
                        <CodeText value={entry.prevHash} copyable copyLabel={m.audit_copy_previous_hash()} />
                    )}
                </dd>
            </dl>
            <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm font-medium text-text-muted">{m.audit_details()}</p>
                {details === null ? (
                    <p className="text-sm text-text-muted">{m.audit_no_details()}</p>
                ) : (
                    <pre
                        data-testid="audit-details"
                        className="rounded-control bg-(--code-text-bg) p-3 font-mono text-xs break-all whitespace-pre-wrap text-(--code-text-text)"
                    >
                        {JSON.stringify(details, null, 2)}
                    </pre>
                )}
            </div>
        </div>
    );
}
