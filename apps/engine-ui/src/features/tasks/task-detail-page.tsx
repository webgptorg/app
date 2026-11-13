import { ChatId, KNOWN_CAPABILITIES, TaskId } from '@ptbk/engine-api';
import type { ReadTaskDetail, ReadTaskOccurrence, TaskLinkTarget } from '@ptbk/engine-api';
import {
    Badge,
    Button,
    EmptyState,
    ErrorState,
    RelativeTime,
    Section,
    Skeleton,
    STATUS_TINT_CLASSES,
    StatusPill,
    useLocale,
    viewTransitionStyle,
} from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Circle, CircleCheck, History as HistoryIcon, MessageSquare } from 'lucide-react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { chatQueryOptions } from '../chat/chat-queries';
import { EntityChip } from '../entities/entity-chip';
import { Crumb, Page } from '../shell/page';
import { splitTaskName } from './task-name';
import {
    occurrenceReasonLabel,
    occurrenceStateLabel,
    occurrenceTone,
    TaskStateBadge,
    taskStateLabel,
    taskTone,
} from './task-state';
import { useTask, useTaskOccurrences } from './tasks-queries';

const route = getRouteApi('/tasks/$taskId');

function isNotFound(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.status === 404;
}

/** One task as the engine models it: state and why, its relations, schedule and the history of its occurrences. */
export function TaskDetailPage() {
    const taskId = TaskId.safeParse(route.useParams().taskId).data;
    return taskId === undefined ? <TaskNotFound /> : <LoadedTask taskId={taskId} />;
}

function TasksCrumb() {
    return <Crumb to="/tasks">{m.tasks_title()}</Crumb>;
}

function LoadedTask({ taskId }: { readonly taskId: TaskId }) {
    const task = useTask(taskId);
    if (task.isPending) {
        return (
            <Page title={m.task_title_loading()} breadcrumbs={[<TasksCrumb key="tasks" />]}>
                <Skeleton shape="block" className="h-40 w-full" />
            </Page>
        );
    }
    if (task.isError) {
        if (isNotFound(task.error)) return <TaskNotFound />;
        return (
            <Page title={m.task_title_loading()} breadcrumbs={[<TasksCrumb key="tasks" />]}>
                <ErrorState
                    message={m.task_load_failed()}
                    onRetry={() => {
                        void task.refetch();
                    }}
                    retrying={task.isFetching}
                />
            </Page>
        );
    }
    return <TaskDetail task={task.data} />;
}

function TaskNotFound() {
    return (
        <Page title={m.task_not_found_title()} breadcrumbs={[<TasksCrumb key="tasks" />]}>
            <EmptyState title={m.task_not_found_title()} description={m.task_not_found_body()} />
        </Page>
    );
}

function TaskDetail({ task }: { readonly task: ReadTaskDetail }) {
    const { readable, stamp } = splitTaskName(task.name);
    return (
        <Page
            title={readable}
            {...(stamp === null ? {} : { titleSuffix: stamp })}
            documentTitle={[task.name, m.tasks_title()]}
            breadcrumbs={[<TasksCrumb key="tasks" />]}
            titleStyle={viewTransitionStyle('task-title', task.id)}
            actions={<DiscussInChat task={task} />}
        >
            <div className="flex flex-col gap-4">
                <TaskFacts task={task} />
                <TaskWhy task={task} />
            </div>
            {task.conditions.length === 0 ? null : <Conditions task={task} />}
            <Relations task={task} />
            <History task={task} />
            {task.notes.length === 0 ? null : (
                <Section title={m.task_notes_title()}>
                    <ul className="flex max-w-prose flex-col gap-2 text-sm">
                        {task.notes.map((note, index) => (
                            <li key={index} className="break-words whitespace-pre-wrap">
                                {note}
                            </li>
                        ))}
                    </ul>
                </Section>
            )}
            <Details task={task} />
        </Page>
    );
}

/** The conversation to change this task in: where it came from, else the first linked chat. */
function discussionChat(task: ReadTaskDetail): ChatId | null {
    if (task.origin?.chatId != null) return task.origin.chatId;
    for (const { target } of task.links) if (target.type === 'chat' && target.chatId !== null) return target.chatId;
    return null;
}

/**
 * Work changes through a conversation, never through task buttons: this opens the task's chat, or starts one with the
 * responsible agent when it has none. Engine-owned work without an agent has nobody to discuss it with here.
 */
function DiscussInChat({ task }: { readonly task: ReadTaskDetail }) {
    const chatsVisible = useAllows({ permission: 'chats.read' });
    const chatId = discussionChat(task);
    const chat = useQuery({
        ...chatQueryOptions(useEngineApi(), chatId ?? ChatId.parse('none')),
        enabled: chatsVisible && chatId !== null,
    });
    if (!chatsVisible) return null;
    const icon = <MessageSquare aria-hidden className="size-4" />;
    if (chat.data !== undefined) {
        return (
            <ButtonLink to="/chats/$chatId" params={{ chatId: chat.data.id }} variant="primary">
                {icon}
                {m.task_discuss_in_chat()}
            </ButtonLink>
        );
    }
    if (chatId !== null && chat.isPending) return null;
    if (task.agentId === null) return null;
    return (
        <ButtonLink to="/agents/$agentId/chat" params={{ agentId: task.agentId }} variant="primary">
            {icon}
            {m.task_discuss_in_chat()}
        </ButtonLink>
    );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 items-center">
            <dt className="sr-only">{label}</dt>
            <dd className="flex min-w-0 items-center">{children}</dd>
        </div>
    );
}

/** State, who does it, how urgent it is and how far along, in one quiet line under the title. */
function TaskFacts({ task }: { readonly task: ReadTaskDetail }) {
    const progress = task.progress !== null && task.progress.total > 0 ? task.progress : null;
    return (
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-text-muted">
            <Fact label={m.task_fact_state()}>
                <TaskStateBadge state={task.state} />
            </Fact>
            <Fact label={m.task_fact_agent()}>
                <TaskOwner task={task} />
            </Fact>
            {task.priority.rank > 0 || task.priority.text !== null ? (
                <Fact label={m.task_fact_priority()}>
                    <span className="tabular-nums">
                        {m.task_priority({ rank: task.priority.rank })}
                        {task.priority.text === null ? null : ` · ${task.priority.text}`}
                    </span>
                </Fact>
            ) : null}
            {progress === null ? null : (
                <Fact label={m.task_fact_progress()}>
                    <span className="tabular-nums">
                        {m.task_meta_progress({ completed: progress.completed, total: progress.total })}
                    </span>
                </Fact>
            )}
            {task.kind === 'engine' ? (
                <Fact label={m.task_fact_kind()}>
                    <Badge>{m.task_kind_engine()}</Badge>
                </Fact>
            ) : null}
            {task.purpose === 'system' && task.kind !== 'engine' ? (
                <Fact label={m.task_fact_purpose()}>
                    <Badge>{m.task_purpose_system()}</Badge>
                </Fact>
            ) : null}
        </dl>
    );
}

function TaskOwner({ task }: { readonly task: ReadTaskDetail }) {
    if (task.kind === 'engine') return <span>{task.executor ?? m.task_owner_engine()}</span>;
    if (task.agentId === null) return <span>{m.task_owner_unassigned()}</span>;
    return <EntityChip kind="agent" id={task.agentId} name={task.agentName ?? task.agentId} />;
}

/** Live or actionable states earn a soft surface; settled ones keep their explanation as quiet text. */
const LOUD: ReadonlySet<StatusTone> = new Set(['live', 'warning', 'danger']);

/** The engine's own words on why the task stands where it does, what it is doing and what comes next. */
function TaskWhy({ task }: { readonly task: ReadTaskDetail }) {
    const summary = task.progress?.summary ?? null;
    if (task.stateReason === null && task.next === null && summary === null) return null;
    const tone = taskTone(task.state);
    return (
        <div
            className={cx(
                'flex max-w-prose flex-col gap-1 text-sm',
                LOUD.has(tone) && cx('soft-surface px-4 py-3', STATUS_TINT_CLASSES[tone]),
            )}
        >
            {/* Explanations come from the engine and its agents: text only. */}
            {task.stateReason === null ? null : <p className="break-words">{task.stateReason}</p>}
            {summary === null ? null : <p className="break-words text-text-muted">{summary}</p>}
            {task.next === null ? null : <p className="break-words text-text-muted">{task.next}</p>}
        </div>
    );
}

function Conditions({ task }: { readonly task: ReadTaskDetail }) {
    return (
        <Section title={m.task_conditions_title()}>
            <ul className="flex flex-col gap-2 text-sm">
                {task.conditions.map((condition, index) => (
                    <li key={index} className="flex items-start gap-2">
                        {condition.met ? (
                            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                        ) : (
                            <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" />
                        )}
                        <span className="break-words">
                            <span className="sr-only">
                                {condition.met ? m.task_condition_met() : m.task_condition_open()}{' '}
                            </span>
                            {condition.text}
                        </span>
                    </li>
                ))}
            </ul>
        </Section>
    );
}

function dependencyLook(state: ReadTaskDetail['dependsOn'][number]['state']): {
    readonly tone: StatusTone;
    readonly label: string;
} {
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

/** A chat by its name, a link once the engine confirms the thread exists. */
function ChatChip({ chatId, name }: { readonly chatId: ChatId | null; readonly name: string }) {
    const chatsVisible = useAllows({ permission: 'chats.read' });
    const chat = useQuery({
        ...chatQueryOptions(useEngineApi(), chatId ?? ChatId.parse('none')),
        enabled: chatsVisible && chatId !== null,
    });
    return <EntityChip kind="chat" id={chat.data?.id ?? null} name={name} />;
}

function LinkTarget({ target }: { readonly target: TaskLinkTarget }) {
    switch (target.type) {
        case 'task':
            return <EntityChip kind="task" id={target.taskId} name={target.name} />;
        case 'agent':
            return <EntityChip kind="agent" id={target.agentId} name={target.name} />;
        case 'chat':
            return <ChatChip chatId={target.chatId} name={target.name} />;
    }
}

function Relation({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="grid gap-1.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-6">
            <dt className="pt-0.5 text-sm text-text-muted">{label}</dt>
            <dd className="min-w-0">
                <ul className="flex flex-col items-start gap-1.5 text-sm">{children}</ul>
            </dd>
        </div>
    );
}

/** A related task with its state in words beside it, quiet, so the chips stay what the eye scans. */
function TaskWithState({
    taskId,
    name,
    tone,
    label,
}: {
    readonly taskId: TaskId | null;
    readonly name: string;
    readonly tone: StatusTone;
    readonly label: string;
}) {
    return (
        <li className="flex max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <EntityChip kind="task" id={taskId} name={name} />
            <StatusPill tone={tone} variant="quiet" className="text-text-muted">
                {label}
            </StatusPill>
        </li>
    );
}

/** Parent and children, prerequisites and dependants, and the directed links, each from the engine's report. */
function Relations({ task }: { readonly task: ReadTaskDetail }) {
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
            <dl className="flex flex-col gap-3">
                {origin === null ? null : (
                    <Relation label={m.task_relation_origin()}>
                        <li className="max-w-full">
                            <Origin task={task} origin={origin} />
                        </li>
                    </Relation>
                )}
                {task.parent === null ? null : (
                    <Relation label={m.task_relation_parent()}>
                        <li className="max-w-full">
                            <EntityChip kind="task" id={task.parent.taskId} name={task.parent.name} />
                        </li>
                    </Relation>
                )}
                {task.children.length === 0 ? null : (
                    <Relation label={m.task_relation_children()}>
                        {task.children.map((child) => (
                            <TaskWithState
                                key={child.taskId ?? child.name}
                                taskId={child.taskId}
                                name={child.name}
                                tone={taskTone(child.state)}
                                label={taskStateLabel(child.state)}
                            />
                        ))}
                    </Relation>
                )}
                {task.dependsOn.length === 0 ? null : (
                    <Relation label={m.task_relation_depends_on()}>
                        {task.dependsOn.map((dependency) => (
                            <TaskWithState
                                key={dependency.taskId ?? dependency.name}
                                taskId={dependency.taskId}
                                name={dependency.name}
                                {...dependencyLook(dependency.state)}
                            />
                        ))}
                    </Relation>
                )}
                {task.blocks.length === 0 ? null : (
                    <Relation label={m.task_relation_blocks()}>
                        {task.blocks.map((dependant) => (
                            <TaskWithState
                                key={dependant.taskId ?? dependant.name}
                                taskId={dependant.taskId}
                                name={dependant.name}
                                tone={taskTone(dependant.state)}
                                label={taskStateLabel(dependant.state)}
                            />
                        ))}
                    </Relation>
                )}
                {outgoing.length === 0 ? null : (
                    <Relation label={m.task_relation_links_to()}>
                        {outgoing.map((link, index) => (
                            <li key={index} className="max-w-full">
                                <LinkTarget target={link.target} />
                            </li>
                        ))}
                    </Relation>
                )}
                {incoming.length === 0 ? null : (
                    <Relation label={m.task_relation_linked_from()}>
                        {incoming.map((link, index) => (
                            <li key={index} className="max-w-full">
                                <LinkTarget target={link.target} />
                            </li>
                        ))}
                    </Relation>
                )}
            </dl>
        </Section>
    );
}

function Origin({
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
        return <ChatChip chatId={chatId} name={link?.target.name ?? m.task_origin_chat()} />;
    }
    if (origin.taskId !== null) {
        const name = task.parent?.taskId === origin.taskId ? task.parent.name : m.task_origin_task();
        return <EntityChip kind="task" id={origin.taskId} name={name} />;
    }
    if (origin.kind === 'goal') return <span>{m.task_origin_goal()}</span>;
    if (origin.kind === 'engine') return <span>{m.task_origin_engine()}</span>;
    if (origin.kind === 'user') return <span>{origin.text ?? m.task_origin_user()}</span>;
    return <span>{origin.text ?? m.task_state_unknown()}</span>;
}

const COLUMN = 'px-2 pb-2 text-start font-medium';

/** Every occurrence newest first: work cycles, recurring slots, reopenings and retries, each with its runs. */
function History({ task }: { readonly task: ReadTaskDetail }) {
    const occurrences = useTaskOccurrences(task.id);
    const runsVisible = useAllows({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' });
    let body: ReactNode;
    if (occurrences.isPending) body = <Skeleton shape="block" className="h-16 w-full" />;
    else if (occurrences.isError) {
        body = (
            <ErrorState
                message={m.task_occurrences_load_failed()}
                onRetry={() => {
                    void occurrences.refetch();
                }}
                retrying={occurrences.isFetching}
            />
        );
    } else {
        const items = occurrences.data.pages.flatMap((page) => page.items);
        body =
            items.length === 0 ? (
                <EmptyState
                    variant="inline"
                    headingLevel={3}
                    icon={<HistoryIcon aria-hidden />}
                    title={m.task_occurrences_empty()}
                />
            ) : (
                <>
                    <div className="-mx-2 overflow-x-auto">
                        <table className="w-full min-w-xl border-collapse text-sm">
                            <thead className="text-xs text-text-muted">
                                <tr>
                                    <th scope="col" className={COLUMN}>
                                        {m.task_history_column_occurrence()}
                                    </th>
                                    <th scope="col" className={COLUMN}>
                                        {m.task_fact_state()}
                                    </th>
                                    <th scope="col" className={COLUMN}>
                                        {m.task_history_column_when()}
                                    </th>
                                    <th scope="col" className={cx(COLUMN, 'w-full')}>
                                        {m.task_history_column_summary()}
                                    </th>
                                    {runsVisible ? (
                                        <th scope="col" className={COLUMN}>
                                            {m.task_history_column_runs()}
                                        </th>
                                    ) : null}
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((occurrence) => (
                                    <OccurrenceRow
                                        key={occurrence.id}
                                        occurrence={occurrence}
                                        runsVisible={runsVisible}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {occurrences.hasNextPage ? (
                        <div className="flex justify-center">
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    void occurrences.fetchNextPage();
                                }}
                                loading={occurrences.isFetchingNextPage}
                            >
                                {m.tasks_show_more()}
                            </Button>
                        </div>
                    ) : null}
                </>
            );
    }
    return <Section title={m.task_occurrences_title()}>{body}</Section>;
}

function OccurrenceRow({
    occurrence,
    runsVisible,
}: {
    readonly occurrence: ReadTaskOccurrence;
    readonly runsVisible: boolean;
}) {
    const at = occurrence.endedAt ?? occurrence.startedAt ?? occurrence.scheduledFor;
    return (
        <tr className="h-10 border-t border-hairline align-middle">
            <td className="px-2 py-2 font-medium whitespace-nowrap tabular-nums">
                <span>
                    {m.task_occurrence_title({
                        sequence: occurrence.sequence,
                        reason: occurrenceReasonLabel(occurrence.reason),
                    })}
                </span>
                {occurrence.cycle > 1 ? (
                    <span className="ms-2 font-normal text-text-muted">
                        {m.task_occurrence_cycle({ cycle: occurrence.cycle })}
                    </span>
                ) : null}
            </td>
            <td className="px-2 py-2">
                <StatusPill tone={occurrenceTone(occurrence.state)} variant="quiet">
                    {occurrenceStateLabel(occurrence.state)}
                </StatusPill>
            </td>
            <td className="px-2 py-2 whitespace-nowrap text-text-muted tabular-nums">
                {at === null ? null : <RelativeTime value={new Date(at)} />}
            </td>
            <td className="px-2 py-2 text-text-muted">
                {occurrence.summary === null ? null : (
                    <span className="line-clamp-2 break-words">{occurrence.summary}</span>
                )}
            </td>
            {runsVisible ? (
                <td className="px-2 py-2">
                    <span className="flex flex-wrap gap-1">
                        {occurrence.runIds.map((runId, index) => (
                            <EntityChip
                                key={runId}
                                kind="run"
                                id={runId}
                                name={
                                    occurrence.runIds.length === 1
                                        ? m.task_occurrence_run()
                                        : m.task_occurrence_run_n({ n: index + 1 })
                                }
                            />
                        ))}
                    </span>
                </td>
            ) : null}
        </tr>
    );
}

function DetailFact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

function DateTime({ at }: { readonly at: string }) {
    const locale = useLocale();
    return (
        <time dateTime={at} className="tabular-nums">
            {locale.formatDateTime(new Date(at))}
        </time>
    );
}

/** Schedule and bookkeeping, shown only where the engine reports a value. */
function Details({ task }: { readonly task: ReadTaskDetail }) {
    return (
        <Section title={m.task_details_title()}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3">
                {task.repeat === null ? null : (
                    <DetailFact label={m.task_fact_repeat()}>
                        {m.task_repeat_every({ every: task.repeat.text })}
                    </DetailFact>
                )}
                {task.nextAt === null ? null : (
                    <DetailFact label={m.task_fact_next()}>
                        <DateTime at={task.nextAt} />
                    </DetailFact>
                )}
                {task.notBefore === null ? null : (
                    <DetailFact label={m.task_fact_not_before()}>
                        <DateTime at={task.notBefore} />
                    </DetailFact>
                )}
                {task.dueAt === null ? null : (
                    <DetailFact label={m.task_fact_due()}>
                        <DateTime at={task.dueAt} />
                    </DetailFact>
                )}
                <DetailFact label={m.task_fact_done_count()}>
                    <span className="tabular-nums">{task.doneCount}</span>
                </DetailFact>
                {task.lastDoneAt === null ? null : (
                    <DetailFact label={m.task_fact_last_done()}>
                        <DateTime at={task.lastDoneAt} />
                    </DetailFact>
                )}
                {task.reopened ? <DetailFact label={m.task_fact_reopened()}>{m.task_reopened_yes()}</DetailFact> : null}
                <DetailFact label={m.task_fact_source()}>
                    {task.sourcePath === null ? (
                        <span className="text-text-muted">{m.task_source_engine()}</span>
                    ) : (
                        <span className="font-mono text-xs">{task.sourcePath}</span>
                    )}
                </DetailFact>
            </dl>
        </Section>
    );
}
