import type { AgentId, ChatId, FileId, IntegrationId, MemberId, RunId, TaskId, TriggerId } from '@ptbk/engine-api';
import { RelativeTime, Skeleton, useLocale } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { FileText, MessageSquare, Plug, Activity, ListTodo, Zap } from 'lucide-react';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { AgentStatusBadge } from '../agents/agent-badges';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { chatQueryOptions } from '../chat/chat-queries';
import { threadMembers } from '../chat/thread-list';
import { formatBytes } from '../files/file-size';
import { fileDetailQueryOptions } from '../files/files-queries';
import { integrationStatusLabel } from '../integrations/integration-status';
import { integrationQueryOptions } from '../integrations/integrations-queries';
import { memberDetailQueryOptions } from '../members/members-queries';
import { runTitle } from '../runs/run-format';
import { runStatusLabel } from '../runs/run-status';
import { runQueryOptions } from '../runs/runs-queries';
import { roleLabel } from '../shell/role-label';
import { splitTaskName } from '../tasks/task-name';
import { TaskStateBadge } from '../tasks/task-state';
import { taskQueryOptions } from '../tasks/tasks-queries';
import { triggerKindLabel } from '../triggers/trigger-labels';
import { triggerQueryOptions } from '../triggers/triggers-queries';
import { EntityCard } from './entity-chip-core';

/** Loading and failure inside a card: a quiet line, never an error banner in a popover. */
function Loaded<Data>({
    query,
    children,
}: {
    readonly query: UseQueryResult<Data>;
    readonly children: (data: Data) => ReactNode;
}) {
    if (query.data !== undefined) return children(query.data);
    if (query.isError) return <span className="text-xs text-text-muted">{m.entity_card_unavailable()}</span>;
    return (
        <span aria-busy="true" className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-24" />
        </span>
    );
}

function Clamp({ children }: { readonly children: ReactNode }) {
    return <span className="line-clamp-3 text-text-muted [overflow-wrap:anywhere]">{children}</span>;
}

export function AgentCard({ agentId, name }: { readonly agentId: AgentId; readonly name: string }) {
    const query = useQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const profile = query.data?.profile ?? { avatarUrl: null, color: null };
    return (
        <EntityCard
            leading={<AgentAvatar name={query.data?.name ?? name} agentKey={agentId} profile={profile} size="xs" />}
            title={query.data?.name ?? name}
            meta={<AgentStatusBadge agentId={agentId} />}
            action={
                <ButtonLink to="/agents/$agentId" params={{ agentId }} size="sm">
                    {m.entity_open_agent()}
                </ButtonLink>
            }
        >
            <Loaded query={query}>
                {(agent) => (agent.profile.description === '' ? null : <Clamp>{agent.profile.description}</Clamp>)}
            </Loaded>
        </EntityCard>
    );
}

export function TaskCard({ taskId, name }: { readonly taskId: TaskId; readonly name: string }) {
    const query = useQuery(taskQueryOptions(useEngineApi(), taskId));
    const { readable, stamp } = splitTaskName(query.data?.name ?? name);
    return (
        <EntityCard
            leading={<ListTodo aria-hidden />}
            title={readable}
            meta={stamp === null ? undefined : <span className="tabular-nums">{stamp}</span>}
            action={
                <ButtonLink to="/tasks/$taskId" params={{ taskId }} size="sm">
                    {m.entity_open_task()}
                </ButtonLink>
            }
        >
            <Loaded query={query}>
                {(task) => (
                    <span className="flex flex-col gap-2">
                        <span className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                            <TaskStateBadge state={task.state} />
                            {task.agentName === null ? null : <span>{task.agentName}</span>}
                            {task.progress !== null && task.progress.total > 0 ? (
                                <span className="tabular-nums">
                                    {m.task_meta_progress({
                                        completed: task.progress.completed,
                                        total: task.progress.total,
                                    })}
                                </span>
                            ) : null}
                        </span>
                        {task.stateReason === null ? null : <Clamp>{task.stateReason}</Clamp>}
                    </span>
                )}
            </Loaded>
        </EntityCard>
    );
}

export function RunCard({ runId, name }: { readonly runId: RunId; readonly name: string }) {
    const query = useQuery(runQueryOptions(useEngineApi(), runId));
    return (
        <EntityCard
            leading={<Activity aria-hidden />}
            title={query.data === undefined ? name : runTitle(query.data)}
            meta={query.data === undefined ? undefined : <span>{runStatusLabel(query.data.status)}</span>}
            action={
                <ButtonLink to="/runs/$runId" params={{ runId }} size="sm">
                    {m.entity_open_run()}
                </ButtonLink>
            }
        >
            <Loaded query={query}>
                {(run) => (
                    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted tabular-nums">
                        {run.agentName === null ? null : <span>{run.agentName}</span>}
                        <RelativeTime value={new Date(run.startedAt ?? run.queuedAt)} />
                    </span>
                )}
            </Loaded>
        </EntityCard>
    );
}

export function ChatCard({ chatId, name }: { readonly chatId: ChatId; readonly name: string }) {
    const query = useQuery(chatQueryOptions(useEngineApi(), chatId));
    return (
        <EntityCard
            leading={<MessageSquare aria-hidden />}
            title={query.data?.title.trim() || name}
            meta={
                query.data === undefined ? undefined : (
                    <RelativeTime value={new Date(query.data.updatedAt)} className="tabular-nums" />
                )
            }
            action={
                <ButtonLink to="/chats/$chatId" params={{ chatId }} size="sm">
                    {m.entity_open_chat()}
                </ButtonLink>
            }
        >
            <Loaded query={query}>
                {(chat) => (
                    <span className="flex flex-col gap-1.5">
                        {threadMembers(chat) === '' ? null : (
                            <span className="text-xs text-text-muted">
                                {m.entity_chat_with({ names: threadMembers(chat) })}
                            </span>
                        )}
                        {chat.preview === null ? null : <Clamp>{chat.preview}</Clamp>}
                    </span>
                )}
            </Loaded>
        </EntityCard>
    );
}

export function FileCard({ fileId, name }: { readonly fileId: FileId; readonly name: string }) {
    const query = useQuery(fileDetailQueryOptions(useEngineApi(), fileId));
    const locale = useLocale();
    return (
        <EntityCard
            leading={<FileText aria-hidden />}
            title={query.data?.name ?? name}
            meta={
                query.data === undefined ? undefined : (
                    <span className="tabular-nums">{formatBytes(locale, query.data.sizeBytes)}</span>
                )
            }
            action={
                <ButtonLink to="/files" search={{ file: fileId }} size="sm">
                    {m.entity_open_file()}
                </ButtonLink>
            }
        >
            <Loaded query={query}>
                {(file) => (
                    <span className="text-xs text-text-muted tabular-nums">
                        <RelativeTime value={new Date(file.createdAt)} />
                    </span>
                )}
            </Loaded>
        </EntityCard>
    );
}

export function TriggerCard({ triggerId, name }: { readonly triggerId: TriggerId; readonly name: string }) {
    const query = useQuery(triggerQueryOptions(useEngineApi(), triggerId));
    return (
        <EntityCard
            leading={<Zap aria-hidden />}
            title={query.data?.name ?? name}
            meta={query.data === undefined ? undefined : <span>{triggerKindLabel(query.data)}</span>}
            action={
                <ButtonLink to="/triggers/$triggerId" params={{ triggerId }} size="sm">
                    {m.entity_open_trigger()}
                </ButtonLink>
            }
        >
            <Loaded query={query}>
                {(trigger) =>
                    trigger.agentName === null ? null : (
                        <span className="text-xs text-text-muted">{trigger.agentName}</span>
                    )
                }
            </Loaded>
        </EntityCard>
    );
}

export function IntegrationCard({
    integrationId,
    name,
}: {
    readonly integrationId: IntegrationId;
    readonly name: string;
}) {
    const query = useQuery(integrationQueryOptions(useEngineApi(), integrationId));
    return (
        <EntityCard
            leading={<Plug aria-hidden />}
            title={query.data?.name ?? name}
            meta={query.data === undefined ? undefined : <span>{integrationStatusLabel(query.data.status)}</span>}
            action={
                <ButtonLink to="/integrations/$integrationId" params={{ integrationId }} size="sm">
                    {m.entity_open_integration()}
                </ButtonLink>
            }
        >
            <Loaded query={query}>{() => null}</Loaded>
        </EntityCard>
    );
}

export function MemberCard({ memberId, name }: { readonly memberId: MemberId; readonly name: string }) {
    const query = useQuery(memberDetailQueryOptions(useEngineApi(), memberId));
    return (
        <EntityCard
            leading={<MemberInitial name={query.data?.displayName ?? name} />}
            title={query.data?.displayName ?? name}
            meta={query.data === undefined ? undefined : <span>{roleLabel(query.data.role)}</span>}
            action={
                <ButtonLink to="/members" size="sm">
                    {m.entity_open_members()}
                </ButtonLink>
            }
        >
            <Loaded query={query}>{() => null}</Loaded>
        </EntityCard>
    );
}

/** A member's initial: people are neutral, so they never read as an agent. */
export function MemberInitial({ name }: { readonly name: string }) {
    return (
        <span
            aria-hidden="true"
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-sunken text-[0.5625rem] font-semibold text-text-muted"
        >
            {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? null}
        </span>
    );
}
