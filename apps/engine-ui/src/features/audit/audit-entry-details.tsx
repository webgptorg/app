import type { ReadAuditEntry } from '@ptbk/engine-api';
import { Button, CopyButton, StatusPill, useLocale } from '@ptbk/ui';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';
import { AUDIT_OUTCOME_LABELS, AUDIT_OUTCOME_TONES } from './audit-labels';

type Details = NonNullable<ReadAuditEntry['details']>;

/** Labels for the `details` keys engines are known to write; any other key reads as its raw name. */
const DETAIL_LABELS: ReadonlyMap<string, () => string> = new Map([
    ['fields', m.audit_detail_fields],
    ['problem', m.audit_detail_problem],
    ['requiredPermission', m.audit_detail_required_permission],
    ['version', m.audit_detail_version],
]);

interface DetailFact {
    readonly key: string;
    readonly label: string;
    readonly value: string;
}

function isScalar(value: unknown): value is string | number | boolean {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Top-level text, numbers, booleans and lists of them; anything nested shows in the raw JSON only. */
function detailFacts(details: Details): readonly DetailFact[] {
    return Object.entries(details).flatMap(([key, value]): DetailFact[] => {
        let text: string | undefined;
        if (isScalar(value)) text = String(value);
        else if (Array.isArray(value) && value.length > 0 && value.every(isScalar)) {
            text = value.map(String).join(', ');
        }
        if (text === undefined) return [];
        return [{ key, label: DETAIL_LABELS.get(key)?.() ?? key, value: text }];
    });
}

/** A hash or ID on one mono line, cut short where it must be, and copied whole; the full value stays in the DOM. */
function MachineValue({ value, copyLabel }: { readonly value: string; readonly copyLabel: string }) {
    return (
        <span className="flex min-w-0 items-center gap-1">
            <code title={value} className="min-w-0 truncate font-mono text-xs text-text-muted">
                {value}
            </code>
            <CopyButton value={value} label={copyLabel} />
        </span>
    );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <>
            <dt className="text-text-muted">{label}</dt>
            <dd className="flex min-h-6 min-w-0 items-center break-words">{children}</dd>
        </>
    );
}

/**
 * The expanded row. `details` comes from the engine and may hold anything a member typed, so it is shown as text,
 * never interpreted: known shapes as facts, the exact JSON on request.
 */
export function AuditEntryDetails({
    entry,
    time,
}: {
    readonly entry: ReadAuditEntry;
    /** The full timestamp, seconds and zone included; the row shows a short one. */
    readonly time: Intl.DateTimeFormat;
}) {
    const locale = useLocale();
    const rawId = useId();
    const [rawOpen, setRawOpen] = useState(false);
    const details = entry.details ?? null;
    return (
        <div className="flex min-w-0 flex-col gap-3 py-3 ps-1">
            <dl className="grid min-w-0 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
                <Row label={m.audit_column_time()}>
                    <time dateTime={entry.at} className="tabular-nums">
                        {time.format(new Date(entry.at))}
                    </time>
                </Row>
                <Row label={m.audit_column_outcome()}>
                    <StatusPill tone={AUDIT_OUTCOME_TONES[entry.outcome]}>
                        {AUDIT_OUTCOME_LABELS[entry.outcome]()}
                    </StatusPill>
                </Row>
                {entry.target === null ? null : (
                    <Row label={m.audit_filter_target_id()}>
                        <MachineValue value={entry.target.id} copyLabel={m.audit_copy_target_id()} />
                    </Row>
                )}
                {(details === null ? [] : detailFacts(details)).map((fact) => (
                    <Row key={fact.key} label={fact.label}>
                        {fact.value}
                    </Row>
                ))}
                {entry.client === null ? null : (
                    <>
                        <Row label={m.audit_column_ip()}>
                            <code className="font-mono text-xs break-all">{entry.client.ip}</code>
                        </Row>
                        {/* Whatever the client sent: shown whole here, as text, since the row only names the device. */}
                        <Row label={m.audit_user_agent()}>
                            <span className="text-xs break-all text-text-muted">{entry.client.userAgent}</span>
                        </Row>
                    </>
                )}
                <Row label={m.audit_sequence()}>
                    <span className="tabular-nums">{locale.formatNumber(entry.seq)}</span>
                </Row>
                <Row label={m.audit_entry_hash()}>
                    <MachineValue value={entry.hash} copyLabel={m.audit_copy_hash()} />
                </Row>
                <Row label={m.audit_previous_hash()}>
                    {entry.prevHash === null ? (
                        <span className="text-text-muted">{m.audit_first_entry()}</span>
                    ) : (
                        <MachineValue value={entry.prevHash} copyLabel={m.audit_copy_previous_hash()} />
                    )}
                </Row>
            </dl>
            {details === null ? null : (
                <div className="flex min-w-0 flex-col items-start gap-2">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="-ms-3"
                        aria-expanded={rawOpen}
                        aria-controls={rawId}
                        onClick={() => {
                            setRawOpen(!rawOpen);
                        }}
                    >
                        {m.audit_raw_details()}
                    </Button>
                    {rawOpen ? (
                        <pre
                            id={rawId}
                            data-testid="audit-details"
                            className="w-full rounded-control bg-(--code-text-bg) p-3 font-mono text-xs break-all whitespace-pre-wrap text-(--code-text-text)"
                        >
                            {JSON.stringify(details, null, 2)}
                        </pre>
                    ) : null}
                </div>
            )}
        </div>
    );
}
