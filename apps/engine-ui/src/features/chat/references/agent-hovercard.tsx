import { Button, PeekCard, useHovercardHide } from '@ptbk/ui';
import { Link } from '@tanstack/react-router';
import { AtSign } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { AgentAvatar } from '../../agents/agent-avatar';
import { formatClock, useElapsedMs } from './elapsed';
import { TaskChip } from './task-chip';
import type { ReadChatTask, ReadChatWorking, ReferenceAgent, ThreadReferences } from './thread-references';

type Step = ReadChatWorking['steps'][number];

/** One step as a line: a tool with its argument in mono, reasoning and notes as quiet prose. Text only. */
export function StepLine({ step }: { readonly step: Step }) {
    if (step.kind === 'tool') {
        return (
            <span className="block truncate font-mono text-xs text-text-muted">
                <span className="text-text">{step.tool}</span> {step.text}
            </span>
        );
    }
    return <span className="line-clamp-2 block text-xs text-text-muted italic">{step.text}</span>;
}

function WorkingNow({ working }: { readonly working: ReadChatWorking }) {
    const elapsed = useElapsedMs(working.startedAt);
    const latest = working.steps.at(-1);
    return (
        <span className="flex flex-col gap-1">
            <span className="meta">
                {m.chat_ref_working({ elapsed: elapsed === null ? '' : formatClock(elapsed) })}
            </span>
            {latest === undefined ? null : <StepLine step={latest} />}
        </span>
    );
}

function OnTask({ task }: { readonly task: ReadChatTask }) {
    return (
        <span className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
                {m.chat_ref_working_on()}
                <TaskChip name={task.name} interactive={false} />
            </span>
            {task.detail === null ? null : (
                <span className="line-clamp-2 block text-xs text-text-muted">{task.detail}</span>
            )}
        </span>
    );
}

/** What the agent is doing in this thread now: its reply in progress first, else a task of its that runs. */
function activityOf(agent: ReferenceAgent, references: ThreadReferences) {
    const working = references.working.find((entry) => entry.author.kind === 'agent' && entry.author.key === agent.key);
    if (working !== undefined) return { kind: 'working', working } as const;
    const task = [...references.tasks.values()].find(
        (entry) => entry.agentId === agent.key && entry.state === 'running',
    );
    return task === undefined ? null : ({ kind: 'task', task } as const);
}

/**
 * Who an agent is and what it does here now, with Open agent and Mention. Its name, role and steps are agent data
 * and render as text only.
 */
export function AgentHovercard({
    agent,
    references,
    onMention,
}: {
    readonly agent: ReferenceAgent;
    readonly references: ThreadReferences;
    /** Addresses the agent in the composer; absent where the member cannot write. */
    readonly onMention?: (() => void) | undefined;
}) {
    const activity = activityOf(agent, references);
    const hide = useHovercardHide();
    return (
        <PeekCard
            kind={m.chat_ref_kind_agent()}
            icon={
                <AgentAvatar
                    name={agent.name}
                    profile={{ avatarUrl: agent.avatarUrl, color: agent.profileColor }}
                    size="xs"
                />
            }
            status={
                activity === null
                    ? { tone: 'neutral', label: m.chat_ref_status_idle() }
                    : { tone: 'live', label: m.chat_ref_status_working() }
            }
            title={agent.name}
            description={agent.description ?? undefined}
            tint={agent.color}
            action={{
                label: m.chat_ref_open_agent(),
                render: (props) => <Link to="/agents/$agentId" params={{ agentId: agent.key }} {...props} />,
            }}
            secondary={
                onMention === undefined ? undefined : (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            hide();
                            onMention();
                        }}
                    >
                        <AtSign aria-hidden className="size-3.5" />
                        {m.chat_ref_mention()}
                    </Button>
                )
            }
        >
            {activity === null ? (
                <span className="text-xs text-text-muted">{m.chat_ref_idle()}</span>
            ) : activity.kind === 'working' ? (
                <WorkingNow working={activity.working} />
            ) : (
                <OnTask task={activity.task} />
            )}
        </PeekCard>
    );
}
