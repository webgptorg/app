import type { AgentId, ChatId, FileId, IntegrationId, MemberId, RunId, TaskId, TriggerId } from '@ptbk/engine-api';
import { PeekCard, RelativeTime, Skeleton, STATUS_TINT_CLASSES, StatusPill, useLocale } from '@ptbk/ui';
import type { PeekCardFact, StatusTone } from '@ptbk/ui';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, FileText, ListTodo, MessageSquare, Plug, User, Zap } from 'lucide-react';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { AgentAvatar, NO_AGENT_PROFILE } from '../agents/agent-avatar';
import { stateLabel } from '../agents/agent-badges';
import { AgentLiveState } from '../agents/agent-live-state';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { chatEntriesQueryOptions, chatQueryOptions } from '../chat/chat-queries';
import { agentColor } from '../chat/references/agent-color';
import { threadMembers } from '../chat/chat-name';
import { purposeLabel } from '../files/file-labels';
import { formatBytes } from '../files/file-size';
import { fileDetailQueryOptions } from '../files/files-queries';
import { chatPreview } from '../home/chat-preview';
import { integrationKindLabel, integrationStatusLabel, kindNameOf } from '../integrations/integration-status';
import { integrationQueryOptions } from '../integrations/integrations-queries';
import { memberDetailQueryOptions } from '../members/members-queries';
import { finishedDurationMs, formatDuration, runTitle } from '../runs/run-format';
import { runSourceLabel } from '../runs/run-source';
import { runStatusLabel } from '../runs/run-status';
import { runQueryOptions } from '../runs/runs-queries';
import { roleLabel } from '../shell/role-label';
import { splitTaskName } from '../tasks/task-name';
import { taskStateLabel, taskTone } from '../tasks/task-state';
import { taskQueryOptions } from '../tasks/tasks-queries';
import { lifecycleLabel, triggerKindLabel } from '../triggers/trigger-labels';
import { useTriggerSummary } from '../triggers/trigger-summary';
import { triggerQueryOptions } from '../triggers/triggers-queries';
import { EntityChip } from './entity-chip';

/** States loud enough to tint the whole card; the others keep the neutral wash and say it in the pill. */
const TINTED: ReadonlySet<StatusTone> = new Set(['danger', 'warning']);

function stateTint(tone: StatusTone): { readonly tintClassName?: string } {
    return TINTED.has(tone) ? { tintClassName: STATUS_TINT_CLASSES[tone] } : {};
}

/** While a card's query runs, its fact rows' shape; when it fails, one quiet line instead of an error in a popover. */
function Pending({ query }: { readonly query: UseQueryResult }) {
    if (query.isError) return <span className="text-xs text-text-muted">{m.entity_card_unavailable()}</span>;
    return (
        <span aria-busy="true" className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-24" />
        </span>
    );
}

function Time({ at }: { readonly at: string }) {
    return <RelativeTime value={new Date(at)} />;
}

/** The fact rows a card has values for, in order. */
function facts(...rows: readonly (PeekCardFact | null)[]): PeekCardFact[] {
    return rows.filter((row): row is PeekCardFact => row !== null);
}

/** An agent inside a card: a quiet chip, since the card is already a popover and needs no second one. */
function AgentFact({ agentId, name }: { readonly agentId: AgentId | null; readonly name: string | null }): ReactNode {
    if (agentId === null) return <span className="text-text-muted">—</span>;
    return <EntityChip kind="agent" id={agentId} name={name ?? agentId} interactive={false} />;
}

const AGENT_TONES: Readonly<Record<string, StatusTone>> = {
    idle: 'neutral',
    running: 'live',
    working: 'live',
    waiting: 'waiting',
    stopped: 'warning',
    error: 'danger',
    failed: 'danger',
};

/** The agent's live state as a quiet pill, as every state reads in a card; a state this UI does not know is a dash. */
function AgentStatusPill({ agentId }: { readonly agentId: AgentId }) {
    return (
        <AgentLiveState agentId={agentId}>
            {(status) => {
                if (status.kind === 'pending') return <Skeleton className="h-3 w-16" />;
                const tone = status.kind === 'state' ? AGENT_TONES[status.state] : undefined;
                if (status.kind !== 'state' || tone === undefined) return <span className="text-text-muted">—</span>;
                return (
                    <StatusPill tone={tone} variant="quiet">
                        {stateLabel(status.state as Parameters<typeof stateLabel>[0])}
                    </StatusPill>
                );
            }}
        </AgentLiveState>
    );
}

export function AgentCard({ agentId, name }: { readonly agentId: AgentId; readonly name: string }) {
    const query = useQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const agent = query.data;
    const profile = agent?.profile ?? NO_AGENT_PROFILE;
    return (
        <PeekCard
            kind={m.entity_kind_agent()}
            icon={
                <AgentAvatar
                    name={agent?.name ?? name}
                    agentKey={agentId}
                    profile={profile}
                    origin={agent?.origin}
                    size="xs"
                />
            }
            tint={agentColor(profile.color, agentId)}
            title={agent?.name ?? name}
            description={
                agent === undefined || agent.profile.description === '' ? undefined : agent.profile.description
            }
            facts={facts(
                { label: m.entity_fact_status(), value: <AgentStatusPill agentId={agentId} /> },
                agent === undefined ? null : { label: m.entity_fact_updated(), value: <Time at={agent.updatedAt} /> },
            )}
            action={{
                label: m.entity_open_agent(),
                render: (props) => <Link {...props} to="/agents/$agentId" params={{ agentId }} />,
            }}
        >
            {agent === undefined ? <Pending query={query} /> : null}
        </PeekCard>
    );
}

export function TaskCard({ taskId, name }: { readonly taskId: TaskId; readonly name: string }) {
    const query = useQuery(taskQueryOptions(useEngineApi(), taskId));
    const task = query.data;
    const { readable } = splitTaskName(task?.name ?? name);
    const tone = task === undefined ? null : taskTone(task.state);
    const progress = task?.progress != null && task.progress.total > 0 ? task.progress : null;
    return (
        <PeekCard
            kind={m.entity_kind_task()}
            icon={<ListTodo />}
            {...(task === undefined || tone === null
                ? {}
                : { status: { tone, label: taskStateLabel(task.state) }, ...stateTint(tone) })}
            title={readable}
            description={task?.stateReason ?? undefined}
            facts={
                task === undefined
                    ? []
                    : facts(
                          {
                              label: m.entity_fact_agent(),
                              value:
                                  task.kind === 'engine' ? (
                                      (task.executor ?? m.task_owner_engine())
                                  ) : (
                                      <AgentFact agentId={task.agentId} name={task.agentName} />
                                  ),
                          },
                          task.priority.rank > 0 || task.priority.text !== null
                              ? { label: m.task_fact_priority(), value: m.task_priority({ rank: task.priority.rank }) }
                              : null,
                          progress === null
                              ? null
                              : {
                                    label: m.entity_fact_subtasks(),
                                    value: m.task_meta_progress({
                                        completed: progress.completed,
                                        total: progress.total,
                                    }),
                                },
                          { label: m.entity_fact_updated(), value: <Time at={task.updatedAt} /> },
                      )
            }
            action={{
                label: m.entity_open_task(),
                render: (props) => <Link {...props} to="/tasks/$taskId" params={{ taskId }} />,
            }}
        >
            {task === undefined ? <Pending query={query} /> : null}
        </PeekCard>
    );
}

const RUN_TONES = {
    queued: 'waiting',
    running: 'live',
    completed: 'success',
    failed: 'danger',
    cancelled: 'neutral',
    unknown: 'neutral',
} as const satisfies Readonly<Record<string, StatusTone>>;

export function RunCard({ runId, name }: { readonly runId: RunId; readonly name: string }) {
    const query = useQuery(runQueryOptions(useEngineApi(), runId));
    const locale = useLocale();
    const run = query.data;
    const tone = run === undefined ? null : RUN_TONES[run.status];
    const duration = run === undefined ? null : finishedDurationMs(run);
    const cost = run?.usage?.cost ?? null;
    const took = [
        duration === null ? null : formatDuration(duration, (value) => locale.formatNumber(value)),
        cost === null ? null : locale.formatCurrency(cost.amount, cost.currency),
    ].filter((part) => part !== null);
    return (
        <PeekCard
            kind={m.entity_kind_run()}
            icon={<Activity />}
            {...(run === undefined || tone === null
                ? {}
                : { status: { tone, label: runStatusLabel(run.status) }, ...stateTint(tone) })}
            title={run === undefined ? name : runTitle(run)}
            description={run?.error?.summary ?? undefined}
            facts={
                run === undefined
                    ? []
                    : facts(
                          {
                              label: m.entity_fact_agent(),
                              value: <AgentFact agentId={run.agentId} name={run.agentName} />,
                          },
                          { label: m.entity_fact_source(), value: runSourceLabel(run.source) },
                          { label: m.entity_fact_started(), value: <Time at={run.startedAt ?? run.queuedAt} /> },
                          took.length === 0 ? null : { label: m.entity_fact_took(), value: took.join(' · ') },
                      )
            }
            action={{
                label: m.entity_open_run(),
                render: (props) => <Link {...props} to="/runs/$runId" params={{ runId }} />,
            }}
        >
            {run === undefined ? <Pending query={query} /> : null}
        </PeekCard>
    );
}

export function ChatCard({ chatId, name }: { readonly chatId: ChatId; readonly name: string }) {
    const engineApi = useEngineApi();
    const locale = useLocale();
    const query = useQuery(chatQueryOptions(engineApi, chatId));
    // Only entries the member already loaded: a card never fetches a thread's history.
    const cached = useInfiniteQuery({ ...chatEntriesQueryOptions(engineApi, chatId), enabled: false }).data;
    const chat = query.data;
    const preview =
        chat === undefined
            ? null
            : chatPreview(
                  chat,
                  cached?.pages.flatMap((page) => page.items),
              );
    const status =
        chat === undefined
            ? undefined
            : chat.questions.length > 0
              ? { tone: 'warning' as const, label: m.chat_needs_you() }
              : chat.working.length > 0
                ? { tone: 'live' as const, label: m.home_chat_working() }
                : undefined;
    const members = chat === undefined ? '' : threadMembers(chat);
    return (
        <PeekCard
            kind={m.entity_kind_chat()}
            icon={<MessageSquare />}
            {...(status === undefined ? {} : { status, ...stateTint(status.tone) })}
            title={chat?.title.trim() || name}
            description={
                preview === null ? undefined : preview.kind === 'working' ? m.home_chat_working() : preview.text
            }
            facts={
                chat === undefined
                    ? []
                    : facts(
                          members === '' ? null : { label: m.entity_fact_with(), value: members },
                          { label: m.entity_fact_messages(), value: locale.formatNumber(chat.messageCount) },
                          { label: m.entity_fact_updated(), value: <Time at={chat.updatedAt} /> },
                      )
            }
            action={{
                label: m.entity_open_chat(),
                render: (props) => <Link {...props} to="/chats/$chatId" params={{ chatId }} />,
            }}
        >
            {chat === undefined ? <Pending query={query} /> : null}
        </PeekCard>
    );
}

export function FileCard({ fileId, name }: { readonly fileId: FileId; readonly name: string }) {
    const query = useQuery(fileDetailQueryOptions(useEngineApi(), fileId));
    const locale = useLocale();
    const file = query.data;
    const scanFailed = file?.scan?.status === 'infected' || file?.scan?.status === 'failed';
    return (
        <PeekCard
            kind={m.entity_kind_file()}
            icon={<FileText />}
            {...(scanFailed
                ? {
                      status: { tone: 'danger' as const, label: m.activity_outcome_scan_failed() },
                      ...stateTint('danger'),
                  }
                : {})}
            title={file?.name ?? name}
            facts={
                file === undefined
                    ? []
                    : facts(
                          { label: m.entity_fact_size(), value: formatBytes(locale, file.sizeBytes) },
                          { label: m.entity_fact_purpose(), value: purposeLabel(file.purpose) },
                          file.agentId === null
                              ? null
                              : {
                                    label: m.entity_fact_agent(),
                                    value: <AgentFact agentId={file.agentId} name={null} />,
                                },
                          { label: m.entity_fact_added(), value: <Time at={file.createdAt} /> },
                      )
            }
            action={{
                label: m.entity_open_file(),
                render: (props) => <Link {...props} to="/files" search={{ file: fileId }} />,
            }}
        >
            {file === undefined ? <Pending query={query} /> : null}
        </PeekCard>
    );
}

const TRIGGER_TONES = {
    active: 'success',
    paused: 'neutral',
    ended: 'neutral',
    failed: 'danger',
    unknown: 'neutral',
} as const satisfies Readonly<Record<string, StatusTone>>;

export function TriggerCard({ triggerId, name }: { readonly triggerId: TriggerId; readonly name: string }) {
    const query = useQuery(triggerQueryOptions(useEngineApi(), triggerId));
    const summary = useTriggerSummary();
    const trigger = query.data;
    const lifecycle = trigger === undefined || trigger.lifecycle === 'unknown' ? null : trigger.lifecycle;
    return (
        <PeekCard
            kind={trigger === undefined ? m.entity_kind_trigger() : triggerKindLabel(trigger)}
            icon={<Zap />}
            {...(lifecycle === null
                ? {}
                : {
                      status: { tone: TRIGGER_TONES[lifecycle], label: lifecycleLabel(lifecycle) },
                      ...stateTint(TRIGGER_TONES[lifecycle]),
                  })}
            title={trigger?.name ?? name}
            description={trigger === undefined ? undefined : summary(trigger)}
            facts={
                trigger === undefined
                    ? []
                    : facts(
                          {
                              label: m.entity_fact_agent(),
                              value: <AgentFact agentId={trigger.agentId} name={trigger.agentName} />,
                          },
                          trigger.nextFireAt === null
                              ? null
                              : { label: m.entity_fact_next(), value: <Time at={trigger.nextFireAt} /> },
                      )
            }
            action={{
                label: m.entity_open_trigger(),
                render: (props) => <Link {...props} to="/triggers/$triggerId" params={{ triggerId }} />,
            }}
        >
            {trigger === undefined ? <Pending query={query} /> : null}
        </PeekCard>
    );
}

const INTEGRATION_TONES = {
    connected: 'success',
    'needs-attention': 'warning',
    disconnected: 'neutral',
    error: 'danger',
    unknown: 'neutral',
} as const satisfies Readonly<Record<string, StatusTone>>;

export function IntegrationCard({
    integrationId,
    name,
}: {
    readonly integrationId: IntegrationId;
    readonly name: string;
}) {
    const query = useQuery(integrationQueryOptions(useEngineApi(), integrationId));
    const integration = query.data;
    const tone = integration === undefined ? null : INTEGRATION_TONES[integration.status];
    return (
        <PeekCard
            kind={m.entity_kind_integration()}
            icon={<Plug />}
            {...(integration === undefined || tone === null
                ? {}
                : { status: { tone, label: integrationStatusLabel(integration.status) }, ...stateTint(tone) })}
            title={integration?.name ?? name}
            facts={
                integration === undefined
                    ? []
                    : facts(
                          { label: m.entity_fact_type(), value: integrationKindLabel(kindNameOf(integration)) },
                          {
                              label: m.entity_fact_agent(),
                              value: <AgentFact agentId={integration.agentId} name={null} />,
                          },
                      )
            }
            action={{
                label: m.entity_open_integration(),
                render: (props) => <Link {...props} to="/integrations/$integrationId" params={{ integrationId }} />,
            }}
        >
            {integration === undefined ? <Pending query={query} /> : null}
        </PeekCard>
    );
}

export function MemberCard({ memberId, name }: { readonly memberId: MemberId; readonly name: string }) {
    const query = useQuery(memberDetailQueryOptions(useEngineApi(), memberId));
    const member = query.data;
    return (
        <PeekCard
            kind={m.entity_kind_member()}
            icon={<User />}
            title={member?.displayName ?? name}
            facts={
                member === undefined
                    ? []
                    : facts(
                          { label: m.entity_fact_role(), value: roleLabel(member.role) },
                          member.lastSeenAt === null
                              ? null
                              : { label: m.entity_fact_last_seen(), value: <Time at={member.lastSeenAt} /> },
                          { label: m.entity_fact_joined(), value: <Time at={member.createdAt} /> },
                      )
            }
            action={{ label: m.entity_open_members(), render: (props) => <Link {...props} to="/members" /> }}
        >
            {member === undefined ? <Pending query={query} /> : null}
        </PeekCard>
    );
}
