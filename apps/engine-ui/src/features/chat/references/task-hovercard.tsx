import { m } from '../../../paraglide/messages';
import { ButtonLink } from '../../../app/link';
import { AgentChip } from './agent-chip';
import { formatClock, useElapsedMs } from './elapsed';
import { TaskStatus } from './task-status';
import type { ReadChatTask } from './thread-references';

function Timer({ task }: { readonly task: ReadChatTask }) {
    const elapsed = useElapsedMs(task.startedAt ?? '', task.endedAt);
    if (task.startedAt === null || elapsed === null) return <span>{m.chat_ref_not_started()}</span>;
    const clock = formatClock(elapsed);
    return (
        <span>
            {task.endedAt === null ? m.chat_ref_running_for({ elapsed: clock }) : m.chat_ref_took({ elapsed: clock })}
        </span>
    );
}

/** A task's state, agent, live detail, timer and commit, with Open task where the tasks page exists. Text only. */
export function TaskHovercard({ task, canOpen }: { readonly task: ReadChatTask; readonly canOpen: boolean }) {
    return (
        <span className="flex w-72 max-w-full flex-col gap-2.5">
            <span className="flex items-center justify-between gap-2 text-xs text-text-muted">
                <TaskStatus state={task.state} />
                {task.reopened ? <span>{m.chat_ref_reopened()}</span> : null}
            </span>
            <span className="font-medium [overflow-wrap:anywhere]">{task.name}</span>
            {task.agentId === null ? null : (
                <span>
                    <AgentChip agentKey={task.agentId} name={task.agentId} interactive={false} />
                </span>
            )}
            {task.detail === null ? null : (
                <span className="line-clamp-3 block text-sm text-text-muted">{task.detail}</span>
            )}
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 meta">
                <Timer task={task} />
                {task.commit === null ? null : (
                    <span>
                        {m.chat_ref_commit()} <span className="font-mono text-text">{task.commit.slice(0, 7)}</span>
                    </span>
                )}
            </span>
            {canOpen && task.taskId !== null ? (
                <span>
                    <ButtonLink to="/tasks/$taskId" params={{ taskId: task.taskId }} size="sm">
                        {m.chat_ref_open_task()}
                    </ButtonLink>
                </span>
            ) : null}
        </span>
    );
}
