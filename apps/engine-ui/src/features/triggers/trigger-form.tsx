import type { AgentId, ReadTrigger } from '@ptbk/engine-api';
import {
    applyServerErrors,
    Banner,
    Combobox,
    DateInput,
    Form,
    FormField,
    FormSubmit,
    Input,
    Textarea,
    useZodForm,
} from '@ptbk/ui';
import type { ComboboxOption, ServerFieldError } from '@ptbk/ui';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { cx } from '../../app/cx';
import { ButtonLink } from '../../app/link';
import { useAppLocale } from '../../app/locale';
import { useNow } from '../../app/ticker';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { UnsavedChangesGuard } from '../book/unsaved-changes-guard';
import { describeRecurrence, weekdayName } from './schedule/describe';
import { previewFires } from './schedule/next-fires';
import {
    createBodyOf,
    emptyFormValues,
    FORM_KINDS,
    formFieldOf,
    formValuesOf,
    INTERVAL_UNITS,
    isCronLike,
    isPreset,
    presetCron,
    previewScheduleOf,
    RECURRENCE_KINDS,
    TriggerFormValues,
    updateBodyOf,
    WEEKDAYS,
} from './trigger-form-values';
import type { IntervalUnit, RecurrenceKind } from './trigger-form-values';
import { FireTime, useBrowserTimeZone } from './trigger-time';
import { useTriggerAgents } from './trigger-agents';
import { useTriggerMutations } from './use-trigger-mutations';

const PREVIEW_COUNT = 5;
/** Monday first, as both languages write a week. */
const WEEK_ORDER = [...WEEKDAYS.slice(1), WEEKDAYS[0]];
const CRON_EXAMPLE = '0 8 * * 1-5';

/** Every IANA zone the browser knows, with the given ones kept even if it does not list them (`UTC` in some). */
function timeZones(keep: readonly string[]): readonly string[] {
    const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return [...new Set([...keep, ...known])].sort((a, b) => a.localeCompare(b));
}

function recurrenceLabel(recurrence: RecurrenceKind): string {
    switch (recurrence) {
        case 'hourly':
            return m.trigger_form_recurrence_hourly();
        case 'daily':
            return m.trigger_form_recurrence_daily();
        case 'weekdays':
            return m.trigger_form_recurrence_weekdays();
        case 'weekly':
            return m.trigger_form_recurrence_weekly();
        case 'once':
            return m.trigger_form_recurrence_once();
        case 'interval':
            return m.trigger_form_recurrence_interval();
        case 'cron':
            return m.trigger_form_recurrence_cron();
    }
}

function unitLabel(unit: IntervalUnit): string {
    switch (unit) {
        case 'minutes':
            return m.trigger_form_unit_minutes();
        case 'hours':
            return m.trigger_form_unit_hours();
        case 'days':
            return m.trigger_form_unit_days();
    }
}

export interface TriggerFormProps {
    /** Editing this trigger; creating a new one without it. */
    readonly trigger?: ReadTrigger;
    /** Preselects the agent on a new trigger (from an agent's tab). */
    readonly agentId?: AgentId;
    /** The trigger was opened from its agent's tab; leaving the form keeps that way back. */
    readonly fromAgent?: boolean;
}

/**
 * Create or edit a trigger. Local checks block a submit only for input that cannot be sent; the preview of the next
 * fires is an estimate and never blocks. The engine's 422 `invalid-schedule` (and 400 `validation-failed`) lands on
 * the field it names, anything it cannot place in a banner above the form. On a wide screen the preview sits beside
 * the fields, below them on a narrow one.
 */
export function TriggerForm({ trigger, agentId, fromAgent = false }: TriggerFormProps) {
    const browserZone = useBrowserTimeZone();
    const { create, update } = useTriggerMutations();
    const [unplaced, setUnplaced] = useState<readonly string[]>([]);
    const agents = useTriggerAgents();
    const defaults = useMemo(
        () =>
            trigger === undefined
                ? emptyFormValues({ ...(agentId === undefined ? {} : { agentId }), timeZone: browserZone })
                : formValuesOf(trigger, browserZone),
        [trigger, agentId, browserZone],
    );
    const zones = useMemo(() => timeZones([browserZone, defaults.timeZone]), [browserZone, defaults.timeZone]);
    const editing = trigger !== undefined;

    const form = useZodForm({
        schema: TriggerFormValues,
        defaultValues: defaults,
        onSubmit: async (values, current) => {
            setUnplaced([]);
            try {
                if (trigger === undefined) {
                    await create.mutateAsync({ body: createBodyOf(values), fromAgent: agentId !== undefined });
                } else {
                    await update.mutateAsync({ id: trigger.id, body: updateBodyOf(values), fromAgent });
                }
            } catch (error) {
                const failure = classifyApiError(error);
                if (failure.kind !== 'problem') return;
                const errors: ServerFieldError[] = (failure.problem.errors ?? []).map((entry) => ({
                    path: formFieldOf(entry.path, values.recurrence),
                    message: entry.message,
                }));
                const left = applyServerErrors(current, errors).map((entry) => entry.message);
                if (errors.length === 0 && failure.problem.code === 'invalid-schedule') {
                    left.push(failure.problem.detail ?? m.trigger_form_invalid_schedule());
                }
                setUnplaced(left);
            }
        },
    });

    const agentItems = agents.list;
    const agentOptions: ComboboxOption[] = agentItems.map((agent) => ({
        value: agent.id,
        label: agent.name,
        leading: <AgentAvatar name={agent.name} agentKey={agent.id} profile={agent.profile} size="2xs" />,
    }));
    if (defaults.agentId !== '' && !agentItems.some((agent) => agent.id === defaults.agentId)) {
        agentOptions.unshift({ value: defaults.agentId, label: trigger?.agentName ?? defaults.agentId });
    }
    const cancel = editing ? (
        <ButtonLink
            to="/triggers/$triggerId"
            params={{ triggerId: trigger.id }}
            search={fromAgent ? { from: 'agent' } : {}}
            variant="ghost"
        >
            {m.trigger_form_cancel()}
        </ButtonLink>
    ) : agentId === undefined ? (
        <ButtonLink to="/triggers" variant="ghost">
            {m.trigger_form_cancel()}
        </ButtonLink>
    ) : (
        <ButtonLink to="/agents/$agentId/triggers" params={{ agentId }} variant="ghost">
            {m.trigger_form_cancel()}
        </ButtonLink>
    );

    return (
        <Form
            form={form}
            className="grid max-w-6xl grid-cols-1 gap-x-12 gap-y-6 xl:grid-cols-[minmax(0,42rem)_minmax(16rem,1fr)]"
        >
            <form.Subscribe selector={(state) => state.values}>
                {(values) => <UnsavedChangesGuard when={hasChanges(values, defaults)} />}
            </form.Subscribe>
            <div className="flex min-w-0 flex-col gap-5 xl:col-start-1">
                {unplaced.length === 0 ? null : (
                    <Banner tone="danger" title={m.trigger_form_refused()}>
                        {/* The engine's own words about what it refused: text only. */}
                        <ul className="list-disc pl-5 break-words">
                            {unplaced.map((message) => (
                                <li key={message}>{message}</li>
                            ))}
                        </ul>
                    </Banner>
                )}
                <div className="grid gap-5 sm:grid-cols-2">
                    {editing ? null : (
                        <ChoiceField
                            form={form}
                            name="kind"
                            label={m.trigger_form_kind()}
                            options={kindOptions()}
                            onChoose={(value) => {
                                const kind = FORM_KINDS.find((candidate) => candidate === value);
                                if (kind !== undefined) form.setFieldValue('kind', kind);
                            }}
                        />
                    )}
                    <ChoiceField
                        form={form}
                        name="agentId"
                        label={m.trigger_form_agent()}
                        required
                        options={agentOptions}
                        placeholder={m.trigger_form_agent_choose()}
                        searchPlaceholder={m.trigger_form_agent_search()}
                        // Without agents.read there is nothing to choose from; a preset or saved agent still shows.
                        disabled={editing || !agents.allowed}
                        {...(agents.allowed || editing || agentId !== undefined
                            ? {}
                            : { hint: m.trigger_form_agent_no_access() })}
                        onChoose={(value) => {
                            form.setFieldValue('agentId', value);
                        }}
                    />
                </div>
                <FormField form={form} name="name" label={m.trigger_form_name()} required>
                    {(control) => <Input {...control.text} autoComplete="off" maxLength={128} />}
                </FormField>
                <form.Subscribe selector={(state) => state.values.kind}>
                    {(kind) =>
                        kind === 'schedule' ? (
                            <ScheduleFields form={form} zones={zones} />
                        ) : (
                            <p className="text-sm text-text-muted">{m.trigger_form_email_hint()}</p>
                        )
                    }
                </form.Subscribe>
            </div>
            <form.Subscribe selector={(state) => state.values}>
                {(values) =>
                    values.kind === 'schedule' ? (
                        <SchedulePreview
                            values={values}
                            className="xl:sticky xl:top-28 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:self-start"
                        />
                    ) : null
                }
            </form.Subscribe>
            <div className="flex flex-wrap gap-2 xl:col-start-1">
                <FormSubmit form={form}>{editing ? m.trigger_form_save() : m.trigger_form_create()}</FormSubmit>
                {cancel}
            </div>
        </Form>
    );
}

function kindOptions(): readonly ComboboxOption[] {
    return [
        { value: 'schedule', label: m.trigger_kind_schedule() },
        { value: 'email', label: m.trigger_kind_email() },
        { value: 'webhook', label: m.trigger_form_webhook_later(), disabled: true },
    ];
}

/** Changed back to what it was is not a change: leaving then loses nothing. */
function hasChanges(values: TriggerFormValues, defaults: TriggerFormValues): boolean {
    return (Object.keys(defaults) as (keyof TriggerFormValues)[]).some((key) => values[key] !== defaults[key]);
}

type TriggerZodForm = ReturnType<typeof useZodForm<typeof TriggerFormValues>>;
type ChoiceName = 'kind' | 'agentId' | 'recurrence' | 'weekday' | 'everyUnit' | 'timeZone';

interface ChoiceFieldProps {
    readonly form: TriggerZodForm;
    readonly name: ChoiceName;
    readonly label: string;
    readonly hint?: ReactNode;
    readonly required?: boolean;
    readonly options: readonly ComboboxOption[];
    readonly placeholder?: string;
    /** Adds a search field to the list, for long ones (agents, time zones). */
    readonly searchPlaceholder?: string;
    readonly disabled?: boolean;
    /** Sets the field from the picked value; each field narrows the string to its own type. */
    readonly onChoose: (value: string) => void;
}

/**
 * A form field picked from a list, on the design system's combobox. It sets the form value itself (the combobox
 * reports a value, not a change event) and, as `FormField` does for typed input, drops the engine's error on the field
 * as soon as the member picks again.
 */
function ChoiceField({
    form,
    name,
    label,
    hint,
    required,
    options,
    placeholder,
    searchPlaceholder,
    disabled = false,
    onChoose,
}: ChoiceFieldProps) {
    return (
        <FormField
            form={form}
            name={name}
            label={label}
            {...(hint === undefined ? {} : { hint })}
            {...(required === undefined ? {} : { required })}
        >
            {(control) => (
                <Combobox
                    id={control.text.id}
                    aria-describedby={control.text['aria-describedby']}
                    aria-invalid={control.text['aria-invalid']}
                    required={control.text.required}
                    name={control.text.name}
                    value={control.text.value === '' ? null : control.text.value}
                    options={options}
                    {...(placeholder === undefined ? {} : { placeholder })}
                    {...(searchPlaceholder === undefined ? {} : { searchable: true, searchPlaceholder })}
                    disabled={disabled}
                    onBlur={control.text.onBlur}
                    onChange={(value) => {
                        form.setFieldMeta(name, (meta) => ({
                            ...meta,
                            errorMap: { ...meta.errorMap, onServer: undefined },
                        }));
                        onChoose(value);
                    }}
                />
            )}
        </FormField>
    );
}

function TimeField({ form }: { readonly form: TriggerZodForm }) {
    return (
        <FormField form={form} name="atTime" label={m.trigger_form_time()} required>
            {(control) => <Input {...control.text} type="time" className="tabular-nums" />}
        </FormField>
    );
}

function ScheduleFields({ form, zones }: { readonly form: TriggerZodForm; readonly zones: readonly string[] }) {
    const zoneOptions = useMemo(() => zones.map((zone) => ({ value: zone, label: zone })), [zones]);
    return (
        <>
            <div className="grid gap-5 sm:grid-cols-2">
                <ChoiceField
                    form={form}
                    name="recurrence"
                    label={m.trigger_form_recurrence()}
                    options={RECURRENCE_KINDS.map((recurrence) => ({
                        value: recurrence,
                        label: recurrenceLabel(recurrence),
                    }))}
                    onChoose={(value) => {
                        const next = RECURRENCE_KINDS.find((candidate) => candidate === value);
                        if (next === undefined) return;
                        // Custom starts from the preset it replaces, so a small tweak needs no cron from scratch.
                        const { recurrence, atTime, weekday } = form.state.values;
                        const cron = isPreset(recurrence) ? presetCron(recurrence, atTime, weekday) : undefined;
                        if (next === 'cron' && cron !== undefined) form.setFieldValue('expression', cron);
                        form.setFieldValue('recurrence', next);
                    }}
                />
                <form.Subscribe selector={(state) => state.values.recurrence}>
                    {(recurrence) => (recurrence === 'weekly' ? <WeekdayField form={form} /> : null)}
                </form.Subscribe>
            </div>
            <form.Subscribe selector={(state) => state.values.recurrence}>
                {(recurrence) => {
                    switch (recurrence) {
                        case 'hourly':
                            return null;
                        case 'daily':
                        case 'weekdays':
                        case 'weekly':
                            return (
                                <div className="grid gap-5 sm:grid-cols-2">
                                    <TimeField form={form} />
                                </div>
                            );
                        case 'once':
                            return (
                                <div className="grid gap-5 sm:grid-cols-2">
                                    <FormField form={form} name="onceAt" label={m.trigger_form_at()} required>
                                        {(control) => <DateInput {...control.text} withTime />}
                                    </FormField>
                                </div>
                            );
                        case 'interval':
                            return (
                                <div className="grid gap-5 sm:grid-cols-2">
                                    <FormField form={form} name="everyAmount" label={m.trigger_form_every()} required>
                                        {(control) => (
                                            <Input
                                                {...control.text}
                                                type="number"
                                                inputMode="numeric"
                                                min={1}
                                                className="tabular-nums"
                                            />
                                        )}
                                    </FormField>
                                    <ChoiceField
                                        form={form}
                                        name="everyUnit"
                                        label={m.trigger_form_unit()}
                                        options={(Object.keys(INTERVAL_UNITS) as IntervalUnit[]).map((unit) => ({
                                            value: unit,
                                            label: unitLabel(unit),
                                        }))}
                                        onChoose={(value) => {
                                            const unit = (Object.keys(INTERVAL_UNITS) as IntervalUnit[]).find(
                                                (candidate) => candidate === value,
                                            );
                                            if (unit !== undefined) form.setFieldValue('everyUnit', unit);
                                        }}
                                    />
                                </div>
                            );
                        case 'cron':
                            return (
                                <FormField
                                    form={form}
                                    name="expression"
                                    label={m.trigger_form_cron()}
                                    hint={
                                        <>
                                            {m.trigger_form_cron_hint()}{' '}
                                            <code className="font-mono whitespace-nowrap">{CRON_EXAMPLE}</code>
                                        </>
                                    }
                                    required
                                >
                                    {(control) => (
                                        <Input
                                            {...control.text}
                                            autoComplete="off"
                                            spellCheck={false}
                                            maxLength={128}
                                            className="font-mono"
                                        />
                                    )}
                                </FormField>
                            );
                    }
                }}
            </form.Subscribe>
            <ChoiceField
                form={form}
                name="timeZone"
                label={m.trigger_form_time_zone()}
                hint={m.trigger_form_time_zone_hint()}
                options={zoneOptions}
                searchPlaceholder={m.trigger_form_time_zone_search()}
                onChoose={(value) => {
                    form.setFieldValue('timeZone', value);
                }}
            />
            <div className="grid gap-5 sm:grid-cols-2">
                <FormField
                    form={form}
                    name="startsAt"
                    label={m.trigger_form_starts()}
                    hint={m.trigger_form_starts_hint()}
                >
                    {(control) => <DateInput {...control.text} withTime />}
                </FormField>
                <FormField form={form} name="endsAt" label={m.trigger_form_ends()} hint={m.trigger_form_ends_hint()}>
                    {(control) => <DateInput {...control.text} withTime />}
                </FormField>
                <FormField
                    form={form}
                    name="maxRunCount"
                    label={m.trigger_form_max_runs()}
                    hint={m.trigger_form_max_runs_hint()}
                >
                    {(control) => (
                        <Input {...control.text} type="number" inputMode="numeric" min={1} className="tabular-nums" />
                    )}
                </FormField>
            </div>
            <FormField
                form={form}
                name="message"
                label={m.trigger_form_message()}
                hint={m.trigger_form_message_hint()}
                required
            >
                {(control) => <Textarea {...control.text} rows={4} />}
            </FormField>
        </>
    );
}

function WeekdayField({ form }: { readonly form: TriggerZodForm }) {
    const { locale } = useAppLocale();
    return (
        <ChoiceField
            form={form}
            name="weekday"
            label={m.trigger_form_weekday()}
            options={WEEK_ORDER.map((day) => ({ value: day, label: weekdayName(Number(day), locale) }))}
            onChoose={(value) => {
                const day = WEEKDAYS.find((candidate) => candidate === value);
                if (day !== undefined) form.setFieldValue('weekday', day);
            }}
        />
    );
}

/**
 * The next five fires as the browser estimates them, as quiet hairline rows; labelled as an estimate, the engine's
 * answer counts.
 */
function SchedulePreview({ values, className }: { readonly values: TriggerFormValues; readonly className?: string }) {
    const now = useNow();
    const { locale } = useAppLocale();
    const browserZone = useBrowserTimeZone();
    const schedule = previewScheduleOf(values, now);
    const fires = schedule === null ? [] : previewFires(schedule, now, PREVIEW_COUNT);
    const zone = isCronLike(values.recurrence) ? values.timeZone : undefined;
    return (
        <section aria-labelledby="trigger-preview-title" className={cx('flex min-w-0 flex-col gap-2', className)}>
            <h2 id="trigger-preview-title" className="text-sm font-semibold">
                {m.trigger_preview_title()}
            </h2>
            {schedule === null ? (
                <p className="text-sm text-text-muted">{m.trigger_preview_incomplete()}</p>
            ) : (
                <>
                    <p className="text-sm">
                        {describeRecurrence(
                            schedule.recurrence.kind === 'once'
                                ? { kind: 'once', at: new Date(schedule.recurrence.at).toISOString() }
                                : schedule.recurrence,
                            { locale, displayTimeZone: browserZone },
                        )}
                    </p>
                    {fires.length === 0 ? (
                        <p className="text-sm text-text-muted">{m.trigger_preview_none()}</p>
                    ) : (
                        <ol className="flex flex-col border-t border-hairline text-sm tabular-nums">
                            {fires.map((at) => (
                                <li key={at} className="border-b border-hairline py-2">
                                    <FireTime at={new Date(at).toISOString()} zone={zone} />
                                </li>
                            ))}
                        </ol>
                    )}
                </>
            )}
            <p className="text-xs text-text-muted">{m.trigger_preview_estimate()}</p>
        </section>
    );
}
