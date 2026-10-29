import { TriggerId } from '@ptbk/engine-api';
import type { ReadTrigger } from '@ptbk/engine-api';
import { ActionMenu, Banner, Card, CodeText, EmptyState, ErrorState, Skeleton, useLocale } from '@ptbk/ui';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { ButtonLink, Link } from '../../app/link';
import { useAppLocale } from '../../app/locale';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { NARROW_QUERY, useMediaQuery } from '../shell/use-media-query';
import { DeleteTriggerDialog } from './delete-trigger-dialog';
import { TriggerListBackLink } from './trigger-back-link';
import { describeRecurrence } from './schedule/describe';
import { endedReasonLabel, triggerKindLabel, TriggerLifecycleBadge } from './trigger-labels';
import { TriggerFiresTable } from './trigger-fires-table';
import { triggerZone } from './trigger-summary';
import { FireTime, formatInZone, useBrowserTimeZone } from './trigger-time';
import { TriggerToggle } from './trigger-toggle';
import { useTrigger } from './triggers-queries';
import { canEdit } from './use-trigger-mutations';

const route = getRouteApi('/triggers/$triggerId/');

function isNotFound(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.status === 404;
}

/** One trigger: what starts it, when it fires next and last, and every fire with the run it started. */
export function TriggerDetailPage() {
    const triggerId = TriggerId.safeParse(route.useParams().triggerId).data;
    return triggerId === undefined ? <TriggerNotFound /> : <LoadedTrigger triggerId={triggerId} />;
}

function LoadedTrigger({ triggerId }: { readonly triggerId: TriggerId }) {
    const trigger = useTrigger(triggerId);
    if (trigger.isPending) return <TriggerDetailSkeleton />;
    if (trigger.isError) {
        if (isNotFound(trigger.error)) return <TriggerNotFound />;
        return (
            <Page title={m.trigger_title_loading()}>
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
    if (!can('triggers.manage')) return null;
    return (
        <div className="flex flex-wrap gap-2">
            <TriggerToggle trigger={trigger} size="md" />
            {canEdit(trigger) ? (
                <ButtonLink
                    to="/triggers/$triggerId/edit"
                    params={{ triggerId: trigger.id }}
                    search={fromAgent ? { from: 'agent' } : {}}
                >
                    <Pencil aria-hidden className="size-4" />
                    {m.trigger_edit()}
                </ButtonLink>
            ) : null}
            <ActionMenu
                items={[
                    {
                        kind: 'item',
                        id: 'delete',
                        label: m.trigger_delete(),
                        tone: 'danger',
                        icon: <Trash2 aria-hidden className="size-4" />,
                        onSelect: onDelete,
                    },
                ]}
            />
        </div>
    );
}

function TriggerDetail({ trigger }: { readonly trigger: ReadTrigger }) {
    const narrow = useMediaQuery(NARROW_QUERY);
    const navigate = useNavigate();
    const fromAgent = route.useSearch().from === 'agent';
    const [deleting, setDeleting] = useState(false);
    const actions = (
        <TriggerActions
            trigger={trigger}
            fromAgent={fromAgent}
            onDelete={() => {
                setDeleting(true);
            }}
        />
    );
    const zone = triggerZone(trigger);
    return (
        <Page
            title={trigger.name}
            back={<TriggerListBackLink agentId={fromAgent ? trigger.agentId : undefined} />}
            {...(narrow ? {} : { actions })}
        >
            <TriggerFacts trigger={trigger} />
            {trigger.lifecycle === 'failed' ? (
                <Banner tone="danger" title={m.trigger_failed_title()}>
                    {m.trigger_failed_body()}
                </Banner>
            ) : null}
            <TriggerConfig trigger={trigger} />
            <TriggerFiresTable triggerId={trigger.id} {...(zone === undefined ? {} : { zone })} />
            {narrow ? (
                <div className="sticky bottom-0 z-10 -mx-4 border-t border-divider bg-raised px-4 py-3 empty:hidden">
                    {actions}
                </div>
            ) : null}
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
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

function TriggerFacts({ trigger }: { readonly trigger: ReadTrigger }) {
    const ended = endedReasonLabel(trigger.endedReason);
    const zone = triggerZone(trigger);
    return (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            <Fact label={m.trigger_fact_lifecycle()}>
                <span className="inline-flex flex-wrap items-center gap-2">
                    <TriggerLifecycleBadge trigger={trigger} />
                    {ended === null ? null : <span className="text-sm text-text-muted">{ended}</span>}
                </span>
            </Fact>
            <Fact label={m.trigger_fact_kind()}>{triggerKindLabel(trigger)}</Fact>
            <Fact label={m.trigger_fact_agent()}>
                <Link to="/agents/$agentId" params={{ agentId: trigger.agentId }}>
                    {trigger.agentName ?? trigger.agentId}
                </Link>
            </Fact>
            <Fact label={m.trigger_fact_next()}>
                <FireTime at={trigger.nextFireAt} zone={zone} countdown />
            </Fact>
            <Fact label={m.trigger_fact_last()}>
                <FireTime at={trigger.lastFiredAt} zone={zone} empty={m.trigger_never_fired()} />
            </Fact>
            <Fact label={m.trigger_fact_created()}>
                <FireTime at={trigger.createdAt} />
            </Fact>
        </dl>
    );
}

function TriggerConfig({ trigger }: { readonly trigger: ReadTrigger }) {
    switch (trigger.kind) {
        case 'email':
            return (
                <Card title={m.trigger_email_title()}>
                    <div className="flex flex-col gap-2">
                        <p className="text-sm text-text-muted">{m.trigger_email_body()}</p>
                        <CodeText value={trigger.config.address} copyable copyLabel={m.trigger_email_copy()} />
                    </div>
                </Card>
            );
        case 'schedule':
            return <ScheduleCard config={trigger.config} />;
        case 'webhook':
            return (
                <Card title={m.trigger_kind_webhook()}>
                    <p className="text-sm text-text-muted">{m.trigger_webhook_later()}</p>
                </Card>
            );
        case 'unknown':
            return (
                <Card title={trigger.rawKind}>
                    <p className="text-sm text-text-muted">{m.trigger_unknown_kind_body({ kind: trigger.rawKind })}</p>
                </Card>
            );
    }
}

type ReadScheduleConfig = Extract<ReadTrigger, { readonly kind: 'schedule' }>['config'];

function ScheduleCard({ config }: { readonly config: ReadScheduleConfig }) {
    const { locale } = useAppLocale();
    const formatters = useLocale();
    const browserZone = useBrowserTimeZone();
    const recurrence = config.recurrence;
    const runs =
        config.maxRunCount === null
            ? m.trigger_run_count({ count: config.runCount })
            : m.trigger_run_count_of({ count: config.runCount, max: config.maxRunCount });
    return (
        <Card title={m.trigger_schedule_title()}>
            <div className="flex flex-col gap-4">
                <p className="text-lg">{describeRecurrence(recurrence, { locale, displayTimeZone: browserZone })}</p>
                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {recurrence.kind === 'cron' ? (
                        <>
                            <Fact label={m.trigger_fact_expression()}>
                                <CodeText value={recurrence.expression} />
                            </Fact>
                            <Fact label={m.trigger_fact_time_zone()}>{recurrence.timeZone}</Fact>
                        </>
                    ) : null}
                    {recurrence.kind === 'once' ? (
                        <Fact label={m.trigger_fact_at()}>
                            <FireTime at={recurrence.at} />
                        </Fact>
                    ) : null}
                    <Fact label={m.trigger_fact_starts()}>
                        <time dateTime={config.startsAt}>
                            {formatInZone(new Date(config.startsAt), browserZone, formatters.locale)}
                        </time>
                    </Fact>
                    <Fact label={m.trigger_fact_ends()}>
                        <FireTime at={config.endsAt} empty={m.trigger_value_never()} />
                    </Fact>
                    <Fact label={m.trigger_fact_runs()}>{runs}</Fact>
                </dl>
                <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-medium">{m.trigger_fact_message()}</h3>
                    {/* Typed by a member and sent to the agent: plain text, never markup. */}
                    <p className="rounded-md bg-sunken p-3 break-words whitespace-pre-wrap">{config.message}</p>
                </div>
            </div>
        </Card>
    );
}

function TriggerNotFound() {
    return (
        <Page title={m.trigger_not_found_title()}>
            <EmptyState
                title={m.trigger_not_found_title()}
                description={m.trigger_not_found_body()}
                action={<ButtonLink to="/triggers">{m.trigger_back_to_list()}</ButtonLink>}
            />
        </Page>
    );
}

function TriggerDetailSkeleton() {
    return (
        <section aria-busy="true" aria-label={m.trigger_title_loading()} className="flex flex-col gap-6">
            <Skeleton shape="text" className="h-8 w-64" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} shape="text" className="h-10 w-full" />
                ))}
            </div>
            <Skeleton shape="block" className="h-48 w-full" />
        </section>
    );
}
