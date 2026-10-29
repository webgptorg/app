import { AUDIT_ACTIONS, AUDIT_OUTCOMES, AUDIT_TARGET_KINDS } from '@ptbk/engine-api';
import type { Member } from '@ptbk/engine-api';
import { Button, Field, Input, Select, useLocale } from '@ptbk/ui';
import { ChevronDown, ListFilter, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { localDayStart } from '../../app/day-range';
import { m } from '../../paraglide/messages';
import { NARROW_QUERY, useMediaQuery } from '../shell/use-media-query';
import { AUDIT_OUTCOME_LABELS, auditActionLabel, auditTargetKindLabel } from './audit-labels';
import { AUDIT_FILTER_KEYS } from './audit-search';
import type { AuditFilterKey, AuditSearch } from './audit-search';

export const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Rarely used filters wait behind "More filters", so the log starts near the top of the page. */
const SECONDARY_KEYS = ['targetKind', 'targetId', 'outcome'] as const satisfies readonly AuditFilterKey[];

export interface AuditFiltersProps {
    readonly search: AuditSearch;
    readonly members: readonly Member[];
    /** Applies a change to the URL, which is the only place the filters live. */
    readonly onChange: (change: Partial<AuditSearch>) => void;
    readonly targetIdText: string;
    readonly onTargetIdTextChange: (text: string) => void;
    readonly onClear: () => void;
    readonly timeZone: string;
}

function choice<T extends string>(value: string, known: readonly T[]): T | undefined {
    return known.find((candidate) => candidate === value);
}

function activeCount(search: AuditSearch, keys: readonly AuditFilterKey[]): number {
    return keys.filter((key) => search[key] !== undefined).length;
}

function Disclosure({
    variant,
    expanded,
    controls,
    onToggle,
    children,
}: {
    readonly variant: 'secondary' | 'ghost';
    readonly expanded: boolean;
    readonly controls: string;
    readonly onToggle: () => void;
    readonly children: ReactNode;
}) {
    return (
        <Button variant={variant} aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
            {children}
            <ChevronDown aria-hidden className={cx('size-4', expanded && 'rotate-180')} />
        </Button>
    );
}

/**
 * Every control reads from and writes to the search params, so a reload or a shared link restores the view. The
 * common filters sit in one row and the rest behind "More filters"; on a phone all of them wait behind "Filters", so
 * the first entry stays on the first screen. Active filters always show as removable chips.
 */
export function AuditFilters({
    search,
    members,
    onChange,
    targetIdText,
    onTargetIdTextChange,
    onClear,
    timeZone,
}: AuditFiltersProps) {
    const narrow = useMediaQuery(NARROW_QUERY);
    const [panelOpen, setPanelOpen] = useState(false);
    const [moreOpen, setMoreOpen] = useState(() => activeCount(search, SECONDARY_KEYS) > 0);
    const panelId = useId();
    const zoneHintId = useId();
    const targetIdInvalid = targetIdText.trim() !== '' && !TARGET_ID_PATTERN.test(targetIdText.trim());
    const memberKnown = search.memberId === undefined || members.some((member) => member.id === search.memberId);

    const dates = (
        <>
            <Field label={m.audit_filter_from()}>
                {(control) => (
                    <Input
                        {...control}
                        aria-describedby={zoneHintId}
                        type="date"
                        value={search.from ?? ''}
                        {...(search.to === undefined ? {} : { max: search.to })}
                        onChange={(event) => {
                            onChange({ from: event.target.value === '' ? undefined : event.target.value });
                        }}
                    />
                )}
            </Field>
            <Field label={m.audit_filter_to()}>
                {(control) => (
                    <Input
                        {...control}
                        aria-describedby={zoneHintId}
                        type="date"
                        value={search.to ?? ''}
                        {...(search.from === undefined ? {} : { min: search.from })}
                        onChange={(event) => {
                            onChange({ to: event.target.value === '' ? undefined : event.target.value });
                        }}
                    />
                )}
            </Field>
        </>
    );
    const zoneHint = (
        <p id={zoneHintId} className="text-sm text-text-muted">
            {m.audit_filter_dates_hint({ zone: timeZone })}
        </p>
    );
    const memberAndAction = (
        <>
            <Field label={m.audit_filter_member()}>
                {(control) => (
                    <Select
                        {...control}
                        value={search.memberId ?? ''}
                        onChange={(event) => {
                            const memberId = members.find((member) => member.id === event.target.value)?.id;
                            onChange({ memberId });
                        }}
                    >
                        <option value="">{m.audit_filter_all_members()}</option>
                        {memberKnown ? null : <option value={search.memberId}>{search.memberId}</option>}
                        {members.map((member) => (
                            <option key={member.id} value={member.id}>
                                {member.displayName}
                            </option>
                        ))}
                    </Select>
                )}
            </Field>
            <Field label={m.audit_filter_action()}>
                {(control) => (
                    <Select
                        {...control}
                        value={search.action ?? ''}
                        onChange={(event) => {
                            onChange({ action: choice(event.target.value, AUDIT_ACTIONS) });
                        }}
                    >
                        <option value="">{m.audit_filter_all_actions()}</option>
                        {AUDIT_ACTIONS.map((action) => (
                            <option key={action} value={action}>
                                {auditActionLabel(action)}
                            </option>
                        ))}
                    </Select>
                )}
            </Field>
        </>
    );
    const secondary = (
        <>
            <Field label={m.audit_filter_target_kind()}>
                {(control) => (
                    <Select
                        {...control}
                        value={search.targetKind ?? ''}
                        onChange={(event) => {
                            onChange({ targetKind: choice(event.target.value, AUDIT_TARGET_KINDS) });
                        }}
                    >
                        <option value="">{m.audit_filter_all_target_kinds()}</option>
                        {AUDIT_TARGET_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                                {auditTargetKindLabel(kind)}
                            </option>
                        ))}
                    </Select>
                )}
            </Field>
            <Field
                label={m.audit_filter_target_id()}
                hint={targetIdInvalid ? undefined : m.audit_filter_target_id_hint()}
                error={targetIdInvalid ? m.audit_filter_target_id_invalid() : undefined}
            >
                {(control) => (
                    <Input
                        {...control}
                        value={targetIdText}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={64}
                        onChange={(event) => {
                            onTargetIdTextChange(event.target.value);
                        }}
                    />
                )}
            </Field>
            <Field label={m.audit_filter_outcome()}>
                {(control) => (
                    <Select
                        {...control}
                        value={search.outcome ?? ''}
                        onChange={(event) => {
                            onChange({ outcome: choice(event.target.value, AUDIT_OUTCOMES) });
                        }}
                    >
                        <option value="">{m.audit_filter_all_outcomes()}</option>
                        {AUDIT_OUTCOMES.map((outcome) => (
                            <option key={outcome} value={outcome}>
                                {AUDIT_OUTCOME_LABELS[outcome]()}
                            </option>
                        ))}
                    </Select>
                )}
            </Field>
        </>
    );
    const chips = <ActiveFilters search={search} members={members} onChange={onChange} onClear={onClear} />;

    if (narrow) {
        const count = activeCount(search, AUDIT_FILTER_KEYS);
        return (
            <div role="search" aria-label={m.audit_filters()} className="flex flex-col gap-3">
                <div className="flex">
                    <Disclosure
                        variant="secondary"
                        expanded={panelOpen}
                        controls={panelId}
                        onToggle={() => {
                            setPanelOpen(!panelOpen);
                        }}
                    >
                        <ListFilter aria-hidden className="size-4" />
                        {count === 0 ? m.audit_filters() : m.audit_filters_count({ count: String(count) })}
                    </Disclosure>
                </div>
                {panelOpen ? (
                    <div id={panelId} className="flex flex-col gap-3">
                        <div className="grid grid-cols-2 gap-3">{dates}</div>
                        {zoneHint}
                        {memberAndAction}
                        {secondary}
                    </div>
                ) : null}
                {chips}
            </div>
        );
    }

    const secondaryCount = activeCount(search, SECONDARY_KEYS);
    return (
        <div role="search" aria-label={m.audit_filters()} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
                <div className="grid min-w-0 flex-1 basis-[36rem] grid-cols-2 gap-3 lg:grid-cols-4">
                    {dates}
                    {memberAndAction}
                </div>
                <Disclosure
                    variant="ghost"
                    expanded={moreOpen}
                    controls={panelId}
                    onToggle={() => {
                        setMoreOpen(!moreOpen);
                    }}
                >
                    {secondaryCount === 0
                        ? m.audit_more_filters()
                        : m.audit_more_filters_count({ count: String(secondaryCount) })}
                </Disclosure>
            </div>
            {zoneHint}
            {moreOpen ? (
                <div id={panelId} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {secondary}
                </div>
            ) : null}
            {chips}
        </div>
    );
}

interface Chip {
    readonly key: AuditFilterKey;
    readonly label: string;
    readonly value: string;
}

const CHIP_ORDER = [
    'from',
    'to',
    'memberId',
    'action',
    'targetKind',
    'targetId',
    'outcome',
] as const satisfies readonly AuditFilterKey[];

function useChips(search: AuditSearch, members: readonly Member[]): readonly Chip[] {
    const locale = useLocale();
    const day = (value: string) => {
        const start = localDayStart(value, 0);
        return start === undefined ? value : locale.formatDate(new Date(start));
    };
    const memberName = (id: string) => members.find((member) => member.id === id)?.displayName ?? id;
    const values: Readonly<Record<AuditFilterKey, (search: AuditSearch) => string | undefined>> = {
        from: ({ from }) => (from === undefined ? undefined : day(from)),
        to: ({ to }) => (to === undefined ? undefined : day(to)),
        memberId: ({ memberId }) => (memberId === undefined ? undefined : memberName(memberId)),
        action: ({ action }) => (action === undefined ? undefined : auditActionLabel(action)),
        targetKind: ({ targetKind }) => (targetKind === undefined ? undefined : auditTargetKindLabel(targetKind)),
        targetId: ({ targetId }) => targetId,
        outcome: ({ outcome }) => (outcome === undefined ? undefined : AUDIT_OUTCOME_LABELS[outcome]()),
    };
    const labels: Readonly<Record<AuditFilterKey, () => string>> = {
        from: m.audit_filter_from,
        to: m.audit_filter_to,
        memberId: m.audit_filter_member,
        action: m.audit_filter_action,
        targetKind: m.audit_filter_target_kind,
        targetId: m.audit_filter_target_id,
        outcome: m.audit_filter_outcome,
    };
    return CHIP_ORDER.flatMap((key) => {
        const value = values[key](search);
        return value === undefined ? [] : [{ key, label: labels[key](), value }];
    });
}

/** The filters in force, each removable on its own; names are shown as text, never markup. */
function ActiveFilters({
    search,
    members,
    onChange,
    onClear,
}: {
    readonly search: AuditSearch;
    readonly members: readonly Member[];
    readonly onChange: (change: Partial<AuditSearch>) => void;
    readonly onClear: () => void;
}) {
    const chips = useChips(search, members);
    if (chips.length === 0) return null;
    return (
        <ul aria-label={m.audit_active_filters()} className="flex flex-wrap items-center gap-2">
            {chips.map((chip) => (
                <li key={chip.key} className="min-w-0">
                    <button
                        type="button"
                        aria-label={m.audit_filter_remove({ filter: `${chip.label}: ${chip.value}` })}
                        onClick={() => {
                            onChange({ [chip.key]: undefined });
                        }}
                        className="inline-flex min-h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-pill border border-border bg-raised ps-3 pe-2 text-sm hover:bg-hover"
                    >
                        <span className="min-w-0 truncate">
                            <span className="text-text-muted">{`${chip.label}: `}</span>
                            {chip.value}
                        </span>
                        <X aria-hidden className="size-3.5 shrink-0 text-text-muted" />
                    </button>
                </li>
            ))}
            <li>
                <Button variant="ghost" size="sm" onClick={onClear}>
                    {m.audit_clear_filters()}
                </Button>
            </li>
        </ul>
    );
}
