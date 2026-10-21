import { AUDIT_ACTIONS, AUDIT_OUTCOMES, AUDIT_TARGET_KINDS } from '@ptbk/engine-api';
import type { Member } from '@ptbk/engine-api';
import { Button, Field, Input, Select } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { AUDIT_OUTCOME_LABELS, auditActionLabel, auditTargetKindLabel } from './audit-labels';
import type { AuditSearch } from './audit-search';

export const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface AuditFiltersProps {
    readonly search: AuditSearch;
    readonly members: readonly Member[];
    /** Applies a change to the URL, which is the only place the filters live. */
    readonly onChange: (change: Partial<AuditSearch>) => void;
    readonly targetIdText: string;
    readonly onTargetIdTextChange: (text: string) => void;
    readonly onClear: () => void;
    readonly filtered: boolean;
    readonly timeZone: string;
}

function choice<T extends string>(value: string, known: readonly T[]): T | undefined {
    return known.find((candidate) => candidate === value);
}

/** Every control reads from and writes to the search params, so a reload or a shared link restores the view. */
export function AuditFilters({
    search,
    members,
    onChange,
    targetIdText,
    onTargetIdTextChange,
    onClear,
    filtered,
    timeZone,
}: AuditFiltersProps) {
    const targetIdInvalid = targetIdText.trim() !== '' && !TARGET_ID_PATTERN.test(targetIdText.trim());
    const memberKnown = search.memberId === undefined || members.some((member) => member.id === search.memberId);
    return (
        <div role="search" aria-label={m.audit_filters()} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={m.audit_filter_from()} hint={m.audit_filter_dates_hint({ zone: timeZone })}>
                {(control) => (
                    <Input
                        {...control}
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
                        type="date"
                        value={search.to ?? ''}
                        {...(search.from === undefined ? {} : { min: search.from })}
                        onChange={(event) => {
                            onChange({ to: event.target.value === '' ? undefined : event.target.value });
                        }}
                    />
                )}
            </Field>
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
            <div className="flex items-end">
                <Button disabled={!filtered && targetIdText === ''} onClick={onClear}>
                    {m.audit_clear_filters()}
                </Button>
            </div>
        </div>
    );
}
