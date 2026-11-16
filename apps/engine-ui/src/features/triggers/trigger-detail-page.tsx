import { TriggerId } from '@ptbk/engine-api';
import type { ReadTrigger } from '@ptbk/engine-api';
import {
    ActionMenu,
    Banner,
    Button,
    CodeText,
    EmptyState,
    ErrorState,
    Section,
    Skeleton,
    useLocale,
    viewTransitionStyle,
} from '@ptbk/ui';
import type { MenuEntry } from '@ptbk/ui';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Mail, Pause, Pencil, Play, Shapes, Timer, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { ButtonLink } from '../../app/link';
import { useAppLocale } from '../../app/locale';
import { m } from '../../paraglide/messages';
import { EntityChip } from '../entities/entity-chip';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { DeleteTriggerDialog } from './delete-trigger-dialog';
import { useTriggerAgents } from './trigger-agents';
import { describeRecurrence } from './schedule/describe';
import { endedReasonLabel, triggerKindLabel, TriggerLifecyclePill } from './trigger-labels';
import { TriggerFiresTable } from './trigger-fires-table';
import { triggerZone } from './trigger-summary';
import { FireTime, formatInZone, useBrowserTimeZone } from './trigger-time';
import { triggerTrail, TriggersCrumb } from './trigger-trail';
import { useTrigger } from './triggers-queries';
import { canEdit, canPause, canResume, useTriggerMutations } from './use-trigger-mutations';

const route = getRouteApi('/triggers/$triggerId/');

function isNotFound(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.status === 404;
}

/** One trigger: what starts it, when it runs next and last, and every fire with the run it started. */
export function TriggerDetailPage() {
    const triggerId = TriggerId.safeParse(route.useParams().triggerId).data;
    return triggerId === undefined ? <TriggerNotFound /> : <LoadedTrigger triggerId={triggerId} />;
}

function LoadedTrigger({ triggerId }: { readonly triggerId: TriggerId }) {
    const trigger = useTrigger(triggerId);
    if (trigger.isPending) {
        return (
            <Page title={m.trigger_title_loading()} breadcrumbs={[<TriggersCrumb key="triggers" />]}>
                <div aria-busy="true" className="flex flex-col gap-6">
                    <Skeleton shape="text" className="h-6 w-72" />
                    <Skeleton shape="block" className="h-48 w-full" />
                </div>
            </Page>
        );
    }
    if (trigger.isError) {
        if (isNotFound(trigger.error)) return <TriggerNotFound />;
        return (
            <Page title={m.trigger_title_loading()} breadcrumbs={[<TriggersCrumb key="triggers" />]}>
                <ErrorState
                    message={m.trigger_load_failed()}
                    onRetry={() => {
                        void trigger.refetch();
                    }}
                    retrying={trigger.isFetching}
                />
            </Page>
        );
    }
    return <TriggerDetail trigger={trigger.data} />;
}

/**
 * The state's next step as the one button (Resume a paused or failed trigger, else Edit) and the rest in the ⋯ menu,
 * Delete last after a separator. Nothing without `triggers.manage`.
 */
function TriggerActions({
    trigger,
    fromAgent,
    onDelete,
}: {
    readonly trigger: ReadTrigger;
    readonly fromAgent: boolean;
    readonly onDelete: () => void;
}) {
    const { can } = usePermissions();
    const { pause, resume } = useTriggerMutations();
    const navigate = useNavigate();
    if (!can('triggers.manage')) return null;
    const target = { id: trigger.id, name: trigger.name };
    const editSearch = fromAgent ? { from: 'agent' as const } : {};
    const resumeFirst = canResume(trigger);
    const editable = canEdit(trigger);
    let primary: ReactNode = null;
    if (resumeFirst) {
        primary = (
            <Button
                variant="primary"
                aria-label={m.trigger_resume_named({ name: trigger.name })}
                onClick={() => {
                    resume.mutate(target);
                }}
            >
                <Play aria-hidden className="size-4" />
                {m.trigger_resume()}
            </Button>
        );
    } else if (editable) {
        primary = (
            <ButtonLink
                to="/triggers/$triggerId/edit"
                params={{ triggerId: trigger.id }}
                search={editSearch}
                variant="primary"
            >
                <Pencil aria-hidden className="size-4" />
                {m.trigger_edit()}
            </ButtonLink>
        );
    }
    const items: MenuEntry[] = [];
    if (canPause(trigger)) {
        items.push({
            kind: 'item',
            id: 'pause',
            label: m.trigger_pause(),
            icon: <Pause aria-hidden className="size-4" />,
            onSelect: () => {
                pause.mutate(target);
            },
        });
    }
    if (resumeFirst && editable) {
        items.push({
            kind: 'item',
            id: 'edit',
            label: m.trigger_edit(),
            icon: <Pencil aria-hidden className="size-4" />,
            onSelect: () => {
                void navigate({
                    to: '/triggers/$triggerId/edit',
                    params: { triggerId: trigger.id },
                    search: editSearch,
                });
            },
        });
    }
    if (items.length > 0) items.push({ kind: 'separator', id: 'danger' });
    items.push({
        kind: 'item',
        id: 'delete',
        label: m.trigger_delete(),
        tone: 'danger',
        icon: <Trash2 aria-hidden className="size-4" />,
        onSelect: onDelete,
    });
    return (
        <>
            {primary}
            <ActionMenu items={items} />
        </>
    );
}

function TriggerDetail({ trigger }: { readonly trigger: ReadTrigger }) {
    const navigate = useNavigate();
    const fromAgent = route.useSearch().from === 'agent';
    const [deleting, setDeleting] = useState(false);
    const zone = triggerZone(trigger);
    return (
        <Page
            title={trigger.name}
            documentTitle={[trigger.name, m.triggers_title()]}
            breadcrumbs={triggerTrail(fromAgent ? trigger : undefined)}
            titleStyle={viewTransitionStyle('trigger-title', trigger.id)}
            actions={
                <TriggerActions
                    trigger={trigger}
                    fromAgent={fromAgent}
                    onDelete={() => {
                        setDeleting(true);
                    }}
                />
            }
        >
            <TriggerFacts trigger={trigger} />
            {trigger.lifecycle === 'failed' ? (
                <Banner tone="danger" title={m.trigger_failed_title()} className="max-w-prose">
                    {m.trigger_failed_body()}
                </Banner>
            ) : null}
            <TriggerConfig trigger={trigger} />
            {trigger.kind === 'schedule' ? <MessagePreview message={trigger.config.message} /> : null}
            <Section title={m.trigger_fires_title()}>
                <TriggerFiresTable triggerId={trigger.id} {...(zone === undefined ? {} : { zone })} />
            </Section>
            {deleting ? (
                <DeleteTriggerDialog
                    trigger={trigger}
                    onClose={() => {
                        setDeleting(false);
                    }}
                    onDeleted={() => {
                        void (fromAgent
                            ? navigate({ to: '/agents/$agentId/triggers', params: { agentId: trigger.agentId } })
                            : navigate({ to: '/triggers' }));
                    }}
                />
            ) : null}
        </Page>
    );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 items-center">
            <dt className="sr-only">{label}</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2">{children}</dd>
        </div>
    );
}

const KIND_ICONS = { email: Mail, schedule: Timer, webhook: Shapes, unknown: Shapes } as const;

/** State, whose agent it starts and what kind it is, in one quiet line under the title. */
function TriggerFacts({ trigger }: { readonly trigger: ReadTrigger }) {
    const ended = endedReasonLabel(trigger.endedReason);
    const KindIcon = KIND_ICONS[trigger.kind];
    return (
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-muted">
            <Fact label={m.trigger_fact_lifecycle()}>
                <TriggerLifecyclePill trigger={trigger} />
                {ended === null ? null : <span>{ended}</span>}
            </Fact>
            <Fact label={m.trigger_fact_agent()}>
                <TriggerAgentChip trigger={trigger} />
            </Fact>
            <Fact label={m.trigger_fact_kind()}>
                <span className="inline-flex items-center gap-1.5">
                    <KindIcon aria-hidden className="size-3.5" />
                    {triggerKindLabel(trigger)}
                </span>
            </Fact>
        </dl>
    );
}

function TriggerAgentChip({ trigger }: { readonly trigger: ReadTrigger }) {
    const profile = useTriggerAgents().byId.get(trigger.agentId)?.profile;
    return (
        <EntityChip
            kind="agent"
            id={trigger.agentId}
            name={trigger.agentName ?? trigger.agentId}
            {...(profile === undefined ? {} : { profile })}
        />
    );
}

/** One property: its name quiet on the left, the value beside it. */
function Property({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="grid grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-x-6 py-1.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
            <dt className="text-sm text-text-subtle">{label}</dt>
            <dd className="min-w-0 text-sm break-words tabular-nums">{children}</dd>
        </div>
    );
}

function Properties({ children }: { readonly children: ReactNode }) {
    return <dl className="flex max-w-2xl flex-col">{children}</dl>;
}

/** When it last ran and when it was made, after each kind's own properties. */
function TimingRows({ trigger }: { readonly trigger: ReadTrigger }) {
    return (
        <>
            <Property label={m.trigger_fact_last()}>
                <FireTime at={trigger.lastFiredAt} zone={triggerZone(trigger)} empty={m.trigger_never_fired()} />
            </Property>
            <Property label={m.trigger_fact_created()}>
                <FireTime at={trigger.createdAt} />
            </Property>
        </>
    );
}

function TriggerConfig({ trigger }: { readonly trigger: ReadTrigger }) {
    switch (trigger.kind) {
        case 'email':
            return (
                <Section title={m.trigger_email_title()} description={m.trigger_email_body()}>
                    <CodeText
                        value={trigger.config.address}
                        copyable
                        copyLabel={m.trigger_email_copy()}
                        className="self-start"
                    />
                    <Properties>
                        <TimingRows trigger={trigger} />
                    </Properties>
                </Section>
            );
        case 'schedule':
            return <ScheduleSection trigger={trigger} />;
        case 'webhook':
            return (
                <Section title={m.trigger_kind_webhook()} description={m.trigger_webhook_later()}>
                    <Properties>
                        <TimingRows trigger={trigger} />
                    </Properties>
                </Section>
            );
        case 'unknown':
            return (
                <Section title={trigger.rawKind} description={m.trigger_unknown_kind_body({ kind: trigger.rawKind })}>
                    <Properties>
                        <TimingRows trigger={trigger} />
                    </Properties>
                </Section>
            );
    }
}

type ScheduleTrigger = Extract<ReadTrigger, { readonly kind: 'schedule' }>;

function ScheduleSection({ trigger }: { readonly trigger: ScheduleTrigger }) {
    const { locale } = useAppLocale();
    const formatters = useLocale();
    const browserZone = useBrowserTimeZone();
    const { config } = trigger;
    const recurrence = config.recurrence;
    const runs =
        config.maxRunCount === null
            ? m.trigger_run_count({ count: config.runCount })
            : m.trigger_run_count_of({ count: config.runCount, max: config.maxRunCount });
    return (
        <Section title={m.trigger_schedule_title()}>
            <p className="text-base">{describeRecurrence(recurrence, { locale, displayTimeZone: browserZone })}</p>
            <Properties>
                <Property label={m.trigger_fact_next()}>
                    <FireTime at={trigger.nextFireAt} zone={triggerZone(trigger)} countdown />
                </Property>
                {recurrence.kind === 'cron' ? (
                    <>
                        <Property label={m.trigger_fact_expression()}>
                            <code className="font-mono text-xs">{recurrence.expression}</code>
                        </Property>
                        <Property label={m.trigger_fact_time_zone()}>{recurrence.timeZone}</Property>
                    </>
                ) : null}
                {recurrence.kind === 'once' ? (
                    <Property label={m.trigger_fact_at()}>
                        <FireTime at={recurrence.at} />
                    </Property>
                ) : null}
                <Property label={m.trigger_fact_starts()}>
                    <time dateTime={config.startsAt}>
                        {formatInZone(new Date(config.startsAt), browserZone, formatters.locale)}
                    </time>
                </Property>
                <Property label={m.trigger_fact_ends()}>
                    <FireTime at={config.endsAt} empty={m.trigger_value_never()} />
                </Property>
                <Property label={m.trigger_fact_runs()}>{runs}</Property>
                <TimingRows trigger={trigger} />
            </Properties>
        </Section>
    );
}

/**
 * What the schedule sends, shaped like a member's message in a chat, which is how the agent receives it. Typed by a
 * member, so it stays plain text, never markup.
 */
function MessagePreview({ message }: { readonly message: string }) {
    return (
        <Section title={m.trigger_fact_message()}>
            <p className="w-fit max-w-full rounded-[1.25rem] rounded-es-small bg-accent-soft px-4 py-2.5 text-sm break-words whitespace-pre-wrap sm:max-w-prose">
                {message}
            </p>
        </Section>
    );
}

function TriggerNotFound() {
    return (
        <Page title={m.trigger_not_found_title()} breadcrumbs={[<TriggersCrumb key="triggers" />]}>
            <EmptyState title={m.trigger_not_found_title()} description={m.trigger_not_found_body()} />
        </Page>
    );
}
