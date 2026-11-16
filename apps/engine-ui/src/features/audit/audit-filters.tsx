import { AUDIT_ACTIONS, AUDIT_OUTCOMES, AUDIT_TARGET_KINDS } from '@ptbk/engine-api';
import type { AuditAction, Member, MemberId } from '@ptbk/engine-api';
import { Avatar, FilterBar, filterField } from '@ptbk/ui';
import type { DataTableView, FilterBarField } from '@ptbk/ui';
import { CalendarClock, CircleDot, Crosshair, Shapes, UserRound } from 'lucide-react';

import { m } from '../../paraglide/messages';
import { AUDIT_OUTCOME_LABELS, auditActionLabel, auditTargetKindLabel } from './audit-labels';
import type { AuditSearch } from './audit-search';

export const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ICON = 'size-3.5';

type TargetKind = (typeof AUDIT_TARGET_KINDS)[number];
type Outcome = (typeof AUDIT_OUTCOMES)[number];

export interface AuditFiltersProps {
    readonly view: DataTableView;
    readonly search: AuditSearch;
    readonly members: readonly Member[];
    /** Applies a change to the URL, which is the only place the filters live. */
    readonly onChange: (change: Partial<AuditSearch>) => void;
    readonly targetIdText: string;
    readonly onTargetIdTextChange: (text: string) => void;
    readonly onClear: () => void;
    readonly timeZone: string;
}

/** Every field reads from and writes to the search params, so a reload or a shared link restores the view. */
export function auditFilterFields(
    search: AuditSearch,
    members: readonly Member[],
    onChange: AuditFiltersProps['onChange'],
    timeZone: string,
): FilterBarField[] {
    const memberOptions = members.map((member) => ({
        value: member.id,
        label: member.displayName,
        icon: <Avatar name={member.displayName} size="2xs" />,
    }));
    // An actor beyond the first page of members stays selected by its ID from the URL until it is removed.
    const actorOptions =
        search.memberId === undefined || members.some((member) => member.id === search.memberId)
            ? memberOptions
            : [...memberOptions, { value: search.memberId, label: search.memberId }];
    return [
        filterField.entity<MemberId>({
            id: 'actor',
            label: m.audit_filter_member(),
            icon: <UserRound className={ICON} />,
            multiple: false,
            options: actorOptions,
            value: search.memberId === undefined ? [] : [search.memberId],
            onChange: (value) => {
                onChange({ memberId: value.at(-1) });
            },
        }),
        // Fifty-odd actions: the entity list brings a search, which an enum's plain list lacks.
        filterField.entity<AuditAction>({
            id: 'action',
            label: m.audit_filter_action(),
            icon: <Shapes className={ICON} />,
            multiple: false,
            options: AUDIT_ACTIONS.map((action) => ({ value: action, label: auditActionLabel(action) })),
            value: search.action === undefined ? [] : [search.action],
            onChange: (value) => {
                onChange({ action: value.at(-1) });
            },
        }),
        filterField.enum<Outcome>({
            id: 'outcome',
            label: m.audit_filter_outcome(),
            icon: <CircleDot className={ICON} />,
            options: AUDIT_OUTCOMES.map((outcome) => ({ value: outcome, label: AUDIT_OUTCOME_LABELS[outcome]() })),
            value: search.outcome,
            onChange: (outcome) => {
                onChange({ outcome });
            },
        }),
        filterField.enum<TargetKind>({
            id: 'targetKind',
            label: m.audit_filter_target_kind(),
            icon: <Crosshair className={ICON} />,
            options: AUDIT_TARGET_KINDS.map((kind) => ({ value: kind, label: auditTargetKindLabel(kind) })),
            value: search.targetKind,
            onChange: (targetKind) => {
                onChange({ targetKind });
            },
        }),
        filterField.dateRange({
            id: 'date',
            label: m.audit_filter_date(),
            icon: <CalendarClock className={ICON} />,
            hint: m.audit_filter_dates_hint({ zone: timeZone }),
            value: { from: search.from, to: search.to },
            onChange: ({ from, to }) => {
                onChange({ from, to });
            },
        }),
    ];
}

/**
 * The shared filter bar over the log: the target ID is its search box, everything else a "+ Filter" chip. A malformed
 * ID is never sent; one quiet line says why.
 */
export function AuditFilters({
    view,
    search,
    members,
    onChange,
    targetIdText,
    onTargetIdTextChange,
    onClear,
    timeZone,
}: AuditFiltersProps) {
    const targetIdInvalid = targetIdText.trim() !== '' && !TARGET_ID_PATTERN.test(targetIdText.trim());
    return (
        <div className="flex flex-col gap-1">
            <FilterBar
                {...view}
                label={m.audit_filters()}
                search={{
                    label: m.audit_filter_target_id(),
                    value: targetIdText,
                    onChange: onTargetIdTextChange,
                    maxLength: 64,
                }}
                fields={auditFilterFields(search, members, onChange, timeZone)}
                onClear={onClear}
            />
            {targetIdInvalid ? (
                <p role="status" className="ps-1 text-xs text-danger">
                    {m.audit_filter_target_id_invalid()}
                </p>
            ) : null}
        </div>
    );
}
