import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { ReadChat } from '@ptbk/engine-api';
import { useLocale } from '@ptbk/ui';

import { cx } from '../../app/cx';
import { Link } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { agentTintClass } from './agent-tint';
import type { TaskView } from './message-views';
import { Elapsed } from './steps-card';
import { ThreadAgent } from './thread-agent';

type ChatTaskState = ReadChat['tasks'][number]['state'];

const STATE_LOOK: Readonly<Record<ChatTaskState, { readonly tone: string; readonly pulse?: true }>> = {
    queued: { tone: 'muted' },
    running: { tone: 'live', pulse: true },
    waiting: { tone: 'warning' },
    blocked: { tone: 'danger' },
    completed: { tone: 'success' },
    failed: { tone: 'danger' },
    cancelled: { tone: 'muted' },
    retired: { tone: 'muted' },
    unknown: { tone: 'muted' },
};

function stateLabel(state: ChatTaskState): string {
    switch (state) {
        case 'queued':
            return m.chat_task_state_queued();
        case 'running':
            return m.chat_task_state_running();
        case 'waiting':
            return m.chat_task_state_waiting();
        case 'blocked':
            return m.chat_task_state_blocked();
        case 'completed':
            return m.chat_task_state_completed();
        case 'failed':
            return m.chat_task_state_failed();
        case 'cancelled':
            return m.chat_task_state_cancelled();
        case 'retired':
            return m.chat_task_state_retired();
        case 'unknown':
            return m.chat_task_state_unknown();
    }
}

function TaskTimer({ task }: { readonly task: ReadChat['tasks'][number] }) {
    const locale = useLocale();
    if (task.startedAt === null) return null;
    if (task.endedAt === null) return <Elapsed since={task.startedAt} />;
    return (
        <span className="font-mono text-xs text-text-muted tabular-nums">
            {locale.formatDuration(Date.parse(task.endedAt) - Date.parse(task.startedAt))}
        </span>
    );
}

/**
 * Where a task came into the thread, with its live state from the thread record, which `chat.changed` refreshes. The
 * name, detail and commit are agent output: text only. Open task is the one link, and only when `tasks@1` is there.
 */
export function TaskCard({ view }: { readonly view: TaskView }) {
    const canOpen = useAllows({ capability: KNOWN_CAPABILITIES.tasks, permission: 'tasks.read' });
    const { task, agent } = view;
    const state = task?.state ?? 'unknown';
    const look = STATE_LOOK[state];
    const taskId = task?.taskId ?? null;
    return (
        <section
            aria-label={`${m.chat_task_label()}: ${view.name}`}
            className={cx(
                'chat-soft chat-enter flex w-full max-w-xl flex-col gap-1.5 px-3.5 py-2.5',
                agentTintClass(agent === null ? null : { kind: 'agent', key: agent.key }),
            )}
        >
            <div className="flex min-w-0 items-center gap-2 text-sm">
                <span className="chat-dot" data-tone={look.tone} data-pulse={look.pulse === true ? '' : undefined} />
                <span className="shrink-0 text-xs font-medium text-text-muted">{stateLabel(state)}</span>
                {task?.reopened === true ? (
                    <span className="shrink-0 text-xs text-text-muted">· {m.chat_task_reopened()}</span>
                ) : null}
                <span className="ms-auto shrink-0">{task === null ? null : <TaskTimer task={task} />}</span>
            </div>
            <p className="min-w-0 font-medium break-words">{view.name}</p>
            {agent !== null || (task?.detail ?? '') !== '' ? (
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    {agent === null ? null : <ThreadAgent name={agent.name} who={agent} />}
                    {task?.detail === null || task?.detail === undefined || task.detail === '' ? null : (
                        <span className="min-w-0 truncate text-sm text-text-muted" title={task.detail}>
                            {task.detail}
                        </span>
                    )}
                </div>
            ) : null}
            {state === 'completed' && (task?.commit !== null || (taskId !== null && canOpen)) ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {task?.commit === null || task?.commit === undefined ? null : (
                        <span className="font-mono text-text-muted">
                            {m.chat_task_commit({ commit: task.commit.slice(0, 7) })}
                        </span>
                    )}
                    {taskId !== null && canOpen ? (
                        <Link to="/tasks/$taskId" params={{ taskId }} className="font-medium">
                            {m.chat_task_open_task()}
                        </Link>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}
