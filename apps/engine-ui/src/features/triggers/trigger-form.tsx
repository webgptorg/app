import type { ReadTrigger } from '@ptbk/engine-api';
import { applyServerErrors, Banner, Form, FormField, FormSubmit, Input, Select, Textarea, useZodForm } from '@ptbk/ui';
import type { ServerFieldError } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { useAppLocale } from '../../app/locale';
import { useNow } from '../../app/ticker';
import { m } from '../../paraglide/messages';
import { agentListQueryOptions } from '../agents/agents-queries';
import { describeRecurrence } from './schedule/describe';
import { previewFires } from './schedule/next-fires';
import {
    createBodyOf,
    emptyFormValues,
    formFieldOf,
    formValuesOf,
    INTERVAL_UNITS,
    previewScheduleOf,
    TriggerFormValues,
    updateBodyOf,
} from './trigger-form-values';
import type { IntervalUnit } from './trigger-form-values';
import { FireTime, useBrowserTimeZone } from './trigger-time';
import { useTriggerMutations } from './use-trigger-mutations';

/** The agent picker lists the first page of agents by name; the engine pages beyond that. */
const AGENT_PICKER_LIMIT = 100;
const PREVIEW_COUNT = 5;

/** Every IANA zone the browser knows, with the given ones kept even if it does not list them (`UTC` in some). */
function timeZones(keep: readonly string[]): readonly string[] {
    const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return [...new Set([...keep, ...known])].sort((a, b) => a.localeCompare(b));
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
    readonly agentId?: string;
}

/**
 * Create or edit a trigger. Local checks block a submit only for input that cannot be sent; the preview of the next
 * fires is an estimate and never blocks. The engine's 422 `invalid-schedule` (and 400 `validation-failed`) lands on
 * the field it names, anything it cannot place in a banner above the form.
 */
export function TriggerForm({ trigger, agentId }: TriggerFormProps) {
    const engineApi = useEngineApi();
    const browserZone = useBrowserTimeZone();
    const { create, update } = useTriggerMutations();
    const [unplaced, setUnplaced] = useState<readonly string[]>([]);
    const agents = useQuery(agentListQueryOptions(engineApi, { sort: 'name', limit: AGENT_PICKER_LIMIT }));
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
                if (trigger === undefined) await create.mutateAsync(createBodyOf(values));
                else await update.mutateAsync({ id: trigger.id, body: updateBodyOf(values) });
            } catch (error) {
                const failure = classifyApiError(error);
                if (failure.kind !== 'problem') return;
                const errors: ServerFieldError[] = (failure.problem.errors ?? []).map((entry) => ({
                    path: formFieldOf(entry.path),
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

    const agentItems = agents.data?.items ?? [];
    const cancel = editing ? (
        <ButtonLink to="/triggers/$triggerId" params={{ triggerId: trigger.id }} variant="ghost">
            {m.trigger_form_cancel()}
        </ButtonLink>
    ) : (
        <ButtonLink to="/triggers" variant="ghost">
            {m.trigger_form_cancel()}
        </ButtonLink>
    );

    return (
        <Form form={form} className="flex max-w-2xl flex-col gap-4">
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
            {editing ? null : (
                <FormField form={form} name="kind" label={m.trigger_form_kind()}>
                    {(control) => (
                        <Select {...control.text}>
                            <option value="schedule">{m.trigger_kind_schedule()}</option>
                            <option value="email">{m.trigger_kind_email()}</option>
                            <option value="webhook" disabled>
                                {m.trigger_form_webhook_later()}
                            </option>
                        </Select>
                    )}
                </FormField>
            )}
            <FormField form={form} name="agentId" label={m.trigger_form_agent()} required>
                {(control) => (
                    <Select {...control.text} disabled={editing}>
                        <option value="">{m.trigger_form_agent_choose()}</option>
                        {defaults.agentId !== '' && !agentItems.some((agent) => agent.id === defaults.agentId) ? (
                            <option value={defaults.agentId}>{trigger?.agentName ?? defaults.agentId}</option>
                        ) : null}
                        {agentItems.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                                {agent.name}
                            </option>
                        ))}
                    </Select>
                )}
            </FormField>
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
            <div className="flex flex-wrap gap-2">
                <FormSubmit form={form}>{editing ? m.trigger_form_save() : m.trigger_form_create()}</FormSubmit>
                {cancel}
            </div>
        </Form>
    );
}

type TriggerZodForm = ReturnType<typeof useZodForm<typeof TriggerFormValues>>;

function ScheduleFields({ form, zones }: { readonly form: TriggerZodForm; readonly zones: readonly string[] }) {
    return (
        <>
            <FormField form={form} name="recurrence" label={m.trigger_form_recurrence()}>
                {(control) => (
                    <Select {...control.text}>
                        <option value="once">{m.trigger_form_recurrence_once()}</option>
                        <option value="interval">{m.trigger_form_recurrence_interval()}</option>
                        <option value="cron">{m.trigger_form_recurrence_cron()}</option>
                    </Select>
                )}
            </FormField>
            <form.Subscribe selector={(state) => state.values.recurrence}>
                {(recurrence) => {
                    switch (recurrence) {
                        case 'once':
                            return (
                                <FormField form={form} name="onceAt" label={m.trigger_form_at()} required>
                                    {(control) => <Input {...control.text} type="datetime-local" />}
                                </FormField>
                            );
                        case 'interval':
                            return (
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <FormField form={form} name="everyAmount" label={m.trigger_form_every()} required>
                                        {(control) => (
                                            <Input {...control.text} type="number" inputMode="numeric" min={1} />
                                        )}
                                    </FormField>
                                    <FormField form={form} name="everyUnit" label={m.trigger_form_unit()}>
                                        {(control) => (
                                            <Select {...control.text}>
                                                {(Object.keys(INTERVAL_UNITS) as IntervalUnit[]).map((unit) => (
                                                    <option key={unit} value={unit}>
                                                        {unitLabel(unit)}
                                                    </option>
                                                ))}
                                            </Select>
                                        )}
                                    </FormField>
                                </div>
                            );
                        case 'cron':
                            return (
                                <FormField
                                    form={form}
                                    name="expression"
                                    label={m.trigger_form_cron()}
                                    hint={m.trigger_form_cron_hint()}
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
            <FormField
                form={form}
                name="timeZone"
                label={m.trigger_form_time_zone()}
                hint={m.trigger_form_time_zone_hint()}
            >
                {(control) => (
                    <Select {...control.text}>
                        {zones.map((zone) => (
                            <option key={zone} value={zone}>
                                {zone}
                            </option>
                        ))}
                    </Select>
                )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                    form={form}
                    name="startsAt"
                    label={m.trigger_form_starts()}
                    hint={m.trigger_form_starts_hint()}
                >
                    {(control) => <Input {...control.text} type="datetime-local" />}
                </FormField>
                <FormField form={form} name="endsAt" label={m.trigger_form_ends()} hint={m.trigger_form_ends_hint()}>
                    {(control) => <Input {...control.text} type="datetime-local" />}
                </FormField>
            </div>
            <FormField
                form={form}
                name="maxRunCount"
                label={m.trigger_form_max_runs()}
                hint={m.trigger_form_max_runs_hint()}
            >
                {(control) => <Input {...control.text} type="number" inputMode="numeric" min={1} />}
            </FormField>
            <FormField
                form={form}
                name="message"
                label={m.trigger_form_message()}
                hint={m.trigger_form_message_hint()}
                required
            >
                {(control) => <Textarea {...control.text} rows={4} />}
            </FormField>
            <form.Subscribe selector={(state) => state.values}>
                {(values) => <SchedulePreview values={values} />}
            </form.Subscribe>
        </>
    );
}

/** The next five fires as the browser estimates them; labelled as an estimate, the engine's answer counts. */
function SchedulePreview({ values }: { readonly values: TriggerFormValues }) {
    const now = useNow();
    const { locale } = useAppLocale();
    const browserZone = useBrowserTimeZone();
    const schedule = previewScheduleOf(values, now);
    const fires = schedule === null ? [] : previewFires(schedule, now, PREVIEW_COUNT);
    const zone = values.recurrence === 'cron' ? values.timeZone : undefined;
    return (
        <section aria-labelledby="trigger-preview-title" className="flex flex-col gap-2 rounded-md bg-sunken p-4">
            <h2 id="trigger-preview-title" className="text-sm font-medium">
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
                        <ol className="flex flex-col gap-1 text-sm">
                            {fires.map((at) => (
                                <li key={at}>
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
