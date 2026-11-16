import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { ReadChat, ReadRun, ReadTask } from '@ptbk/engine-api';
import { EmptyState, Section } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Activity, CirclePause, ListTodo } from 'lucide-react';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { StepLine } from '../chat/references/agent-hovercard';
import { formatClock, useElapsedMs } from '../chat/references/elapsed';
import { chatName } from '../chat/thread-list';
import { EntityChip } from '../entities/entity-chip';
import { runTitle } from '../runs/run-format';
import { runListQueryOptions } from '../runs/runs-queries';
import { useAgentLook } from './use-agent-look';
import { useHomeTasks } from './use-home-tasks';

function Timer({ since }: { readonly since: string | null }) {
    const elapsed = useElapsedMs(since ?? '');
    if (since === null || elapsed === null) return null;
    return <span className="shrink-0 text-xs text-text-muted tabular-nums">{formatClock(elapsed)}</span>;
}

/** One piece of live work: who, on what, the latest step, and how long it has been going. */
function WorkRow({
    leading,
    title,
    detail,
    since,
}: {
    readonly leading: ReactNode;
    readonly title: ReactNode;
    readonly detail?: ReactNode;
    readonly since: string | null;
}) {
    return (
        <li className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 flex shrink-0 [&>svg]:size-5 [&>svg]:text-text-muted">{leading}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">{title}</span>
                {detail === undefined || detail === null ? null : <span className="min-w-0">{detail}</span>}
            </span>
            <Timer since={since} />
        </li>
    );
}

function ChatWork({ chat, working }: { readonly chat: ReadChat; readonly working: ReadChat['working'][number] }) {
    const author = chat.members.find(
        (member) => member.kind === working.author.kind && member.key === working.author.key,
    );
    const name = author?.name ?? working.author.key;
    const look = useAgentLook(working.author.key);
    const latest = working.steps.at(-1);
    return (
        <WorkRow
            leading={<AgentAvatar name={name} agentKey={working.author.key} profile={look.profile} size="xs" />}
            title={
                <>
                    <span className="font-medium">{m.home_working_in_chat({ name })}</span>
                    <Link
                        to="/chats/$chatId"
                        params={{ chatId: chat.id }}
                        variant="standalone"
                        className="min-w-0 truncate text-text-muted"
                    >
                        {chatName(chat)}
                    </Link>
                </>
            }
            detail={latest === undefined ? null : <StepLine step={latest} />}
            since={working.startedAt}
        />
    );
}

function TaskWork({ task }: { readonly task: ReadTask }) {
    const detail = task.progress?.summary ?? task.stateReason;
    return (
        <WorkRow
            leading={<ListTodo aria-hidden />}
            title={
                <>
                    <EntityChip kind="task" id={task.id} name={task.name} />
                    {task.agentId === null ? null : (
                        <EntityChip kind="agent" id={task.agentId} name={task.agentName ?? task.agentId} />
                    )}
                    {task.progress !== null && task.progress.total > 0 ? (
                        <span className="text-xs text-text-muted tabular-nums">
                            {m.task_meta_progress({ completed: task.progress.completed, total: task.progress.total })}
                        </span>
                    ) : null}
                </>
            }
            detail={
                detail === null ? null : (
                    <span className="line-clamp-1 text-xs text-text-muted [overflow-wrap:anywhere]">{detail}</span>
                )
            }
            since={null}
        />
    );
}

function RunWork({ run }: { readonly run: ReadRun }) {
    return (
        <WorkRow
            leading={<Activity aria-hidden />}
            title={
                <>
                    <EntityChip kind="run" id={run.id} name={runTitle(run)} />
                    {run.agentName === null ? null : <EntityChip kind="agent" id={run.agentId} name={run.agentName} />}
                </>
            }
            since={run.startedAt}
        />
    );
}

/**
 * Work happening now: agents replying in chats (with their latest step), running tasks, and runs that belong to
 * neither, each with a timer. One live surface; nothing running is one quiet line.
 */
export function WorkingNow({ chats }: { readonly chats: readonly ReadChat[] | undefined }) {
    const engineApi = useEngineApi();
    const runsVisible = useAllows({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' });
    const { tasks } = useHomeTasks('active');
    const runs = useQuery({ ...runListQueryOptions(engineApi, { status: 'running' }), enabled: runsVisible });
    const replies = (chats ?? []).flatMap((chat) => chat.working.map((working) => ({ chat, working })));
    const running = tasks ?? [];
    // A run of a task or a chat reply is already shown as that task or reply.
    const loose = runsVisible
        ? (runs.data?.items ?? []).filter((run) => (run.taskId ?? null) === null && run.chatId === null)
        : [];
    const count = replies.length + running.length + loose.length;
    return (
        <Section title={m.home_working_now()} {...(count === 0 ? {} : { count })}>
            {count === 0 ? (
                <EmptyState
                    variant="inline"
                    headingLevel={3}
                    icon={<CirclePause aria-hidden />}
                    title={m.home_working_none()}
                />
            ) : (
                <ul className="soft-surface flex flex-col divide-y divide-hairline [--tint:var(--color-live)]">
                    {replies.map(({ chat, working }) => (
                        <ChatWork
                            key={`${chat.id}:${working.author.kind}:${working.author.key}`}
                            chat={chat}
                            working={working}
                        />
                    ))}
                    {running.map((task) => (
                        <TaskWork key={task.id} task={task} />
                    ))}
                    {loose.map((run) => (
                        <RunWork key={run.id} run={run} />
                    ))}
                </ul>
            )}
        </Section>
    );
}
