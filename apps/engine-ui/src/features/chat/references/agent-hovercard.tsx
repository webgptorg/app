import { AgentId } from '@ptbk/engine-api';
import { Button, useHovercardHide } from '@ptbk/ui';
import { AtSign } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { agentHovercard } from '../../entities/entity-chip';
import type { AgentCardHere } from '../../entities/entity-cards';
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

function MentionButton({ onMention }: { readonly onMention: () => void }) {
    const hide = useHovercardHide();
    return (
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
    );
}

/** What a thread adds to the agent's card: what it does here now, and Mention where the member can write. */
export function threadAgentHere(
    agent: ReferenceAgent,
    references: ThreadReferences,
    onMention: (() => void) | undefined,
): AgentCardHere {
    const activity = activityOf(agent, references);
    return {
        working: activity?.kind === 'working',
        detail:
            activity === null ? (
                <span className="text-xs text-text-muted">{m.chat_ref_idle()}</span>
            ) : activity.kind === 'working' ? (
                <WorkingNow working={activity.working} />
            ) : (
                <OnTask task={activity.task} />
            ),
        secondary: onMention === undefined ? undefined : <MentionButton onMention={onMention} />,
    };
}

/**
 * The agent's card, the same one every agent reference in the app opens, with what it does in this thread now and
 * Mention. `null` for a participant key that is not an agent ID, which has no card to show. Its name and steps are
 * agent data and render as text only.
 */
export function threadAgentHovercard(
    agent: ReferenceAgent,
    references: ThreadReferences,
    onMention?: () => void,
): ReturnType<typeof agentHovercard> | null {
    const agentId = AgentId.safeParse(agent.key).data;
    if (agentId === undefined) return null;
    return agentHovercard(agentId, agent.name, threadAgentHere(agent, references, onMention));
}
