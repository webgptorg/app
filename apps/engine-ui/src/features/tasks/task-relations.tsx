import { AgentId, ChatId, TaskId } from '@ptbk/engine-api';
import type { ReadTaskDetail, TaskLinkTarget } from '@ptbk/engine-api';
import { RelativeTime, Section, StatusPill } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Bot, ListTodo, MessageSquare, Sparkles } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { chatQueryOptions } from '../chat/chat-queries';
import { EntityChip } from '../entities/entity-chip';
import { taskStateLabel, taskTone } from './task-state';
import { taskQueryOptions } from './tasks-queries';

export interface RelationState {
    readonly tone: StatusTone;
    readonly label: string;
}

export function dependencyState(state: ReadTaskDetail['dependsOn'][number]['state']): RelationState {
    switch (state) {
        case 'met':
            return { tone: 'success', label: m.task_dependency_met() };
        case 'pending':
            return { tone: 'waiting', label: m.task_dependency_pending() };
        case 'failed':
            return { tone: 'danger', label: m.task_dependency_failed() };
        case 'missing':
            return { tone: 'danger', label: m.task_dependency_missing() };
        case 'cycle':
            return { tone: 'danger', label: m.task_dependency_cycle() };
        case 'unknown':
            return { tone: 'neutral', label: m.task_state_unknown() };
    }
}

/**
 * One related thing as a table-like row, as Home's activity and the shared tables draw them: its type icon, the
 * chips and state in the middle, and when it last changed at the end in tabular figures. On a phone the middle wraps
 * to a second line.
 */
function Row({
    icon,
    children,
    at,
}: {
    readonly icon: ReactNode;
    readonly children: ReactNode;
    readonly at?: string | null | undefined;
}) {
    return (
        <li className="grid min-h-10 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3 py-2 sm:items-center">
            <span className="flex h-6 items-center text-text-muted [&>svg]:size-4">{icon}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">{children}</span>
            <span className="flex h-6 min-w-20 items-center justify-end text-xs whitespace-nowrap text-text-muted tabular-nums">
                {at === undefined || at === null ? null : <RelativeTime value={new Date(at)} />}
            </span>
        </li>
    );
}

function AgentOf({ agentId, name }: { readonly agentId: AgentId | null; readonly name: string | null }) {
    if (agentId === null) return null;
    return <EntityChip kind="agent" id={agentId} name={name ?? agentId} />;
}

/**
 * A related task: its chip, its state (the relation's own, e.g. a dependency's standing, else the task's), its agent
 * and when it changed, from the task itself where the engine resolves it (one cached query per related task).
 */
function TaskRow({
    taskId,
    name,
    state,
}: {
    readonly taskId: TaskId | null;
    readonly name: string;
    readonly state?: RelationState | undefined;
}) {
    const allowed = useAllows({ permission: 'tasks.read' });
    const task = useQuery({
        ...taskQueryOptions(useEngineApi(), taskId ?? TaskId.parse('none')),
        enabled: allowed && taskId !== null,
    }).data;
    const shown =
        state ?? (task === undefined ? undefined : { tone: taskTone(task.state), label: taskStateLabel(task.state) });
    return (
        <Row icon={<ListTodo aria-hidden />} at={task?.updatedAt}>
            <EntityChip kind="task" id={taskId} name={name} />
            {shown === undefined ? null : <StatusPill tone={shown.tone}>{shown.label}</StatusPill>}
            {task === undefined ? null : <AgentOf agentId={task.agentId} name={task.agentName} />}
        </Row>
    );
}

/** A chat by its name, a link once the engine confirms the thread exists, with its first agent and its last change. */
function ChatRow({ chatId, name }: { readonly chatId: ChatId | null; readonly name: string }) {
    const chatsVisible = useAllows({ permission: 'chats.read' });
    const chat = useQuery({
        ...chatQueryOptions(useEngineApi(), chatId ?? ChatId.parse('none')),
        enabled: chatsVisible && chatId !== null,
    }).data;
    const agent = chat?.members.find((member) => member.kind === 'agent');
    const state =
        chat === undefined
            ? undefined
            : chat.questions.length > 0
              ? { tone: 'warning' as const, label: m.chat_needs_you() }
              : chat.working.length > 0
                ? { tone: 'live' as const, label: m.home_chat_working() }
                : undefined;
    return (
        <Row icon={<MessageSquare aria-hidden />} at={chat?.updatedAt}>
            <EntityChip kind="chat" id={chat?.id ?? null} name={name} />
            {state === undefined ? null : <StatusPill tone={state.tone}>{state.label}</StatusPill>}
            {agent === undefined ? null : (
                <AgentOf agentId={AgentId.safeParse(agent.key).data ?? null} name={agent.name} />
            )}
        </Row>
    );
}

function AgentRow({ agentId, name }: { readonly agentId: AgentId | null; readonly name: string }) {
    const allowed = useAllows({ permission: 'agents.read' });
    const agent = useQuery({
        ...agentDetailQueryOptions(useEngineApi(), agentId ?? AgentId.parse('none')),
        enabled: allowed && agentId !== null,
    }).data;
    return (
        <Row icon={<Bot aria-hidden />} at={agent?.updatedAt}>
            <EntityChip
                kind="agent"
                id={agentId}
                name={name}
                {...(agent === undefined ? {} : { profile: agent.profile })}
            />
        </Row>
    );
}

/** Where the task came from when that is no entity ("Added by the owner"): a quiet row of words. */
function WordsRow({ children }: { readonly children: ReactNode }) {
    return (
        <Row icon={<Sparkles aria-hidden />}>
            <span className="text-text-muted">{children}</span>
        </Row>
    );
}

function LinkRow({ target }: { readonly target: TaskLinkTarget }) {
    switch (target.type) {
        case 'task':
            return <TaskRow taskId={target.taskId} name={target.name} />;
        case 'agent':
            return <AgentRow agentId={target.agentId} name={target.name} />;
        case 'chat':
            return <ChatRow chatId={target.chatId} name={target.name} />;
    }
}

/** A small group header with its count over hairline rows, as the shared tables group theirs. */
function Group({
    label,
    count,
    children,
}: {
    readonly label: string;
    readonly count: number;
    readonly children: ReactNode;
}) {
    const id = useId();
    return (
        <div role="group" aria-labelledby={id} className="flex flex-col">
            <h3
                id={id}
                className="flex items-baseline gap-2 border-b border-hairline pt-3 pb-1.5 text-xs font-medium text-text-muted"
            >
                <span>{label}</span> <span className="tabular-nums">{count}</span>
            </h3>
            <ul className="flex flex-col divide-y divide-hairline">{children}</ul>
        </div>
    );
}

function OriginRow({
    task,
    origin,
}: {
    readonly task: ReadTaskDetail;
    readonly origin: NonNullable<ReadTaskDetail['origin']>;
}) {
    // `text` is the Book's own wording (`Chat {…}`); the chat or task is named as the links and parent name it.
    if (origin.chatId !== null) {
        const chatId = origin.chatId;
        const link = task.links.find(({ target }) => target.type === 'chat' && target.chatId === chatId);
        return <ChatRow chatId={chatId} name={link?.target.name ?? m.task_origin_chat()} />;
    }
    if (origin.taskId !== null) {
        const name = task.parent?.taskId === origin.taskId ? task.parent.name : m.task_origin_task();
        return <TaskRow taskId={origin.taskId} name={name} />;
    }
    if (origin.kind === 'goal') return <WordsRow>{m.task_origin_goal()}</WordsRow>;
    if (origin.kind === 'engine') return <WordsRow>{m.task_origin_engine()}</WordsRow>;
    if (origin.kind === 'user') return <WordsRow>{origin.text ?? m.task_origin_user()}</WordsRow>;
    return <WordsRow>{origin.text ?? m.task_state_unknown()}</WordsRow>;
}

/**
 * Where the task came from, what it is part of, its subtasks, what it depends on and blocks, and its directed links:
 * each a group of table-like rows with chips, states, agents and times. Empty groups are left out, and with nothing
 * related at all the section is.
 */
export function TaskRelations({ task }: { readonly task: ReadTaskDetail }) {
    const outgoing = task.links.filter((link) => link.direction === 'outgoing');
    const incoming = task.links.filter((link) => link.direction === 'incoming');
    const origin = task.origin;
    const empty =
        task.parent === null &&
        task.children.length === 0 &&
        task.dependsOn.length === 0 &&
        task.blocks.length === 0 &&
        task.links.length === 0 &&
        origin === null;
    if (empty) return null;
    return (
        <Section title={m.task_relations_title()}>
            <div className="flex flex-col gap-2">
                {origin === null ? null : (
                    <Group label={m.task_relation_origin()} count={1}>
                        <OriginRow task={task} origin={origin} />
                    </Group>
                )}
                {task.parent === null ? null : (
                    <Group label={m.task_relation_parent()} count={1}>
                        <TaskRow taskId={task.parent.taskId} name={task.parent.name} />
                    </Group>
                )}
                {task.children.length === 0 ? null : (
                    <Group label={m.task_relation_children()} count={task.children.length}>
                        {task.children.map((child) => (
                            <TaskRow
                                key={child.taskId ?? child.name}
                                taskId={child.taskId}
                                name={child.name}
                                state={{ tone: taskTone(child.state), label: taskStateLabel(child.state) }}
                            />
                        ))}
                    </Group>
                )}
                {task.dependsOn.length === 0 ? null : (
                    <Group label={m.task_relation_depends_on()} count={task.dependsOn.length}>
                        {task.dependsOn.map((dependency) => (
                            <TaskRow
                                key={dependency.taskId ?? dependency.name}
                                taskId={dependency.taskId}
                                name={dependency.name}
                                state={dependencyState(dependency.state)}
                            />
                        ))}
                    </Group>
                )}
                {task.blocks.length === 0 ? null : (
                    <Group label={m.task_relation_blocks()} count={task.blocks.length}>
                        {task.blocks.map((dependant) => (
                            <TaskRow
                                key={dependant.taskId ?? dependant.name}
                                taskId={dependant.taskId}
                                name={dependant.name}
                                state={{ tone: taskTone(dependant.state), label: taskStateLabel(dependant.state) }}
                            />
                        ))}
                    </Group>
                )}
                {outgoing.length === 0 ? null : (
                    <Group label={m.task_relation_links_to()} count={outgoing.length}>
                        {outgoing.map((link, index) => (
                            <LinkRow key={index} target={link.target} />
                        ))}
                    </Group>
                )}
                {incoming.length === 0 ? null : (
                    <Group label={m.task_relation_linked_from()} count={incoming.length}>
                        {incoming.map((link, index) => (
                            <LinkRow key={index} target={link.target} />
                        ))}
                    </Group>
                )}
            </div>
        </Section>
    );
}
