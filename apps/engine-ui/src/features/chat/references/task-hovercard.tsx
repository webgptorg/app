import { PeekCard, STATUS_TINT_CLASSES } from '@ptbk/ui';
import type { PeekCardFact } from '@ptbk/ui';
import { Link } from '@tanstack/react-router';
import { ListTodo } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { AgentChip } from './agent-chip';
import { formatClock, useElapsedMs } from './elapsed';
import { CHAT_TASK_STATUS_TONES, chatTaskStateLabel, chatTaskTone } from './task-status';
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
    const tone = CHAT_TASK_STATUS_TONES[chatTaskTone(task.state)];
    const facts: PeekCardFact[] = [];
    if (task.agentId !== null) {
        facts.push({
            label: m.chat_ref_fact_agent(),
            value: <AgentChip agentKey={task.agentId} name={task.agentId} interactive={false} />,
        });
    }
    facts.push({ label: m.chat_ref_fact_time(), value: <Timer task={task} /> });
    if (task.commit !== null) {
        facts.push({ label: m.chat_ref_commit(), value: <span className="font-mono">{task.commit.slice(0, 7)}</span> });
    }
    const taskId = task.taskId;
    return (
        <PeekCard
            kind={task.reopened ? `${m.chat_ref_kind_task()} · ${m.chat_ref_reopened()}` : m.chat_ref_kind_task()}
            icon={<ListTodo />}
            status={{ tone, label: chatTaskStateLabel(task.state) }}
            title={task.name}
            description={task.detail ?? undefined}
            facts={facts}
            tintClassName={STATUS_TINT_CLASSES[tone]}
            action={
                canOpen && taskId !== null
                    ? {
                          label: m.chat_ref_open_task(),
                          render: (props) => <Link to="/tasks/$taskId" params={{ taskId }} {...props} />,
                      }
                    : undefined
            }
        />
    );
}
