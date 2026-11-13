import { useLocale } from '@ptbk/ui';

import { cx } from '../../app/cx';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import type { TaskView } from './message-views';
import { AgentChip } from './references/agent-chip';
import { CHAT_TASK_TINT_CLASSES, chatTaskTone, TaskStatus } from './references/task-status';
import type { ReadChatTask } from './references/thread-references';
import { useThreadReferences } from './references/thread-references';
import { Elapsed } from './steps-card';

function TaskTimer({ task }: { readonly task: ReadChatTask }) {
    const locale = useLocale();
    if (task.startedAt === null) return null;
    if (task.endedAt === null) return <Elapsed since={task.startedAt} />;
    return <span className="meta">{locale.formatDuration(Date.parse(task.endedAt) - Date.parse(task.startedAt))}</span>;
}

/**
 * Where a task came into the thread, with its live state from the thread record, which `chat.changed` refreshes. The
 * name, detail and commit are agent output: text only. Open task is its one link, and only where `tasks@1` leads.
 */
export function TaskCard({ view }: { readonly view: TaskView }) {
    const canOpenTasks = useThreadReferences()?.canOpenTasks ?? false;
    const { task, agent } = view;
    const state = task?.state ?? 'unknown';
    const taskId = task?.taskId ?? null;
    const detail = task?.detail ?? '';
    const commit = task?.commit ?? null;
    const open = state === 'completed' && taskId !== null && canOpenTasks;
    return (
        <section
            aria-label={view.name}
            className={cx(
                'flex w-full max-w-xl flex-col gap-1.5 px-3.5 py-2.5 soft-surface',
                CHAT_TASK_TINT_CLASSES[chatTaskTone(state)],
            )}
        >
            <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-text-muted">
                <TaskStatus state={state} />
                {task?.reopened === true ? <span>· {m.chat_ref_reopened()}</span> : null}
                <span className="ms-auto shrink-0">{task === null ? null : <TaskTimer task={task} />}</span>
            </div>
            <p className="min-w-0 font-medium break-words">{view.name}</p>
            {agent === null && detail === '' ? null : (
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    {agent === null ? null : <AgentChip agentKey={agent.key} name={agent.name} interactive={false} />}
                    {detail === '' ? null : (
                        <span className="min-w-0 truncate text-text-muted" title={detail}>
                            {detail}
                        </span>
                    )}
                </div>
            )}
            {state === 'completed' && (commit !== null || open) ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {commit === null ? null : (
                        <span className="meta">
                            {m.chat_ref_commit()}{' '}
                            <span className="font-mono" title={commit}>
                                {commit.slice(0, 7)}
                            </span>
                        </span>
                    )}
                    {open ? (
                        <Link to="/tasks/$taskId" params={{ taskId }} className="font-medium">
                            {m.chat_ref_open_task()}
                        </Link>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}
