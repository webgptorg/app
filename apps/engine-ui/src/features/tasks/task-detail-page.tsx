import { ChatId, KNOWN_CAPABILITIES, TaskId } from '@ptbk/engine-api';
import type { ReadTaskDetail, ReadTaskOccurrence, TaskLinkTarget } from '@ptbk/engine-api';
import { Badge, Button, Card, EmptyState, ErrorState, RelativeTime, Skeleton, useLocale } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Circle, CircleCheck, MessageSquare } from 'lucide-react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink, Link } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { chatQueryOptions } from '../chat/chat-queries';
import { BackLink, Page } from '../shell/page';
import { occurrenceReasonLabel, occurrenceStateLabel, occurrenceTone, TaskStateBadge } from './task-state';
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

function LoadedTask({ taskId }: { readonly taskId: TaskId }) {
    const task = useTask(taskId);
    if (task.isPending) {
        return (
            <Page title={m.task_title_loading()} back={<BackToTasks />}>
                <Skeleton shape="block" className="h-40 w-full" />
            </Page>
        );
    }
    if (task.isError) {
        if (isNotFound(task.error)) return <TaskNotFound />;
        return (
            <Page title={m.task_title_loading()} back={<BackToTasks />}>
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

function BackToTasks() {
    return <BackLink to="/tasks">{m.task_back_to_tasks()}</BackLink>;
}

function TaskNotFound() {
    return (
        <Page title={m.task_not_found_title()} back={<BackToTasks />}>
            <EmptyState title={m.task_not_found_title()} description={m.task_not_found_body()} />
        </Page>
    );
}

function TaskDetail({ task }: { readonly task: ReadTaskDetail }) {
    return (
        <Page
            title={task.name}
            documentTitle={[task.name, m.tasks_title()]}
            back={<BackToTasks />}
            actions={<DiscussInChat task={task} />}
        >
            <TaskSummary task={task} />
            {task.conditions.length === 0 ? null : <ConditionsCard task={task} />}
            <RelationsCard task={task} />
            <OccurrencesCard task={task} />
            {task.notes.length === 0 ? null : (
                <Card title={m.task_notes_title()}>
                    <ul className="flex flex-col gap-2 text-sm">
                        {task.notes.map((note, index) => (
                            <li key={index} className="break-words whitespace-pre-wrap">
                                {note}
                            </li>
                        ))}
                    </ul>
                </Card>
            )}
            <DetailsCard task={task} />
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
            <ButtonLink to="/chats/$chatId" params={{ chatId: chat.data.id }}>
                {icon}
                {m.task_discuss_in_chat()}
            </ButtonLink>
        );
    }
    if (chatId !== null && chat.isPending) return null;
    if (task.agentId === null) return null;
    return (
        <ButtonLink to="/agents/$agentId/chat" params={{ agentId: task.agentId }}>
            {icon}
            {m.task_discuss_in_chat()}
        </ButtonLink>
    );
}

function SummaryItem({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 items-center">
            <dt className="sr-only">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

/** State, who does it and how urgent it is, then the engine's own words on why it stands where it does. */
function TaskSummary({ task }: { readonly task: ReadTaskDetail }) {
    return (
        <div className="-mt-3 flex flex-col gap-3">
            <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-muted">
                <SummaryItem label={m.task_fact_state()}>
                    <TaskStateBadge state={task.state} />
                </SummaryItem>
                {task.kind === 'engine' ? (
                    <SummaryItem label={m.task_fact_kind()}>
                        <Badge>{m.task_kind_engine()}</Badge>
                    </SummaryItem>
                ) : null}
                {task.purpose === 'system' && task.kind !== 'engine' ? (
                    <SummaryItem label={m.task_fact_purpose()}>
                        <Badge>{m.task_purpose_system()}</Badge>
                    </SummaryItem>
                ) : null}
                <SummaryItem label={m.task_fact_agent()}>
                    <TaskOwner task={task} />
                </SummaryItem>
                {task.priority.rank > 0 || task.priority.text !== null ? (
                    <SummaryItem label={m.task_fact_priority()}>
                        {m.task_priority({ rank: task.priority.rank })}
                        {task.priority.text === null ? null : ` · ${task.priority.text}`}
                    </SummaryItem>
                ) : null}
                {task.progress !== null && task.progress.total > 0 ? (
                    <SummaryItem label={m.task_fact_progress()}>
                        {m.task_meta_progress({ completed: task.progress.completed, total: task.progress.total })}
                    </SummaryItem>
                ) : null}
            </dl>
            {task.stateReason === null && task.next === null && task.progress?.summary == null ? null : (
                <div className="flex max-w-prose flex-col gap-1 text-sm">
                    {/* Explanations come from the engine and its agents: text only. */}
                    {task.stateReason === null ? null : <p className="break-words">{task.stateReason}</p>}
                    {task.progress?.summary == null ? null : (
                        <p className="break-words text-text-muted">{task.progress.summary}</p>
                    )}
                    {task.next === null ? null : <p className="break-words text-text-muted">{task.next}</p>}
                </div>
            )}
        </div>
    );
}

function TaskOwner({ task }: { readonly task: ReadTaskDetail }) {
    if (task.kind === 'engine') return <span>{task.executor ?? m.task_owner_engine()}</span>;
    if (task.agentId === null) return <span>{m.task_owner_unassigned()}</span>;
    return (
        <Link to="/agents/$agentId" params={{ agentId: task.agentId }}>
            {task.agentName ?? task.agentId}
        </Link>
    );
}

function ConditionsCard({ task }: { readonly task: ReadTaskDetail }) {
    return (
        <Card title={m.task_conditions_title()}>
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
        </Card>
    );
}

function TaskRefLink({ taskId, name }: { readonly taskId: TaskId | null; readonly name: string }) {
    if (taskId === null) return <span>{name}</span>;
    return (
        <Link to="/tasks/$taskId" params={{ taskId }} className="break-words">
            {name}
        </Link>
    );
}

function dependencyLabel(state: ReadTaskDetail['dependsOn'][number]['state']): string {
    switch (state) {
        case 'met':
            return m.task_dependency_met();
        case 'pending':
            return m.task_dependency_pending();
        case 'failed':
            return m.task_dependency_failed();
        case 'missing':
            return m.task_dependency_missing();
        case 'cycle':
            return m.task_dependency_cycle();
        case 'unknown':
            return m.task_state_unknown();
    }
}

function Relation({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd>
                <ul className="flex flex-col gap-1.5 text-sm">{children}</ul>
            </dd>
        </div>
    );
}

function LinkTarget({ target }: { readonly target: TaskLinkTarget }) {
    switch (target.type) {
        case 'task':
            return <TaskRefLink taskId={target.taskId} name={target.name} />;
        case 'agent':
            return target.agentId === null ? (
                <span>{target.name}</span>
            ) : (
                <Link to="/agents/$agentId" params={{ agentId: target.agentId }}>
                    {target.name}
                </Link>
            );
        case 'chat':
            return <ChatLink chatId={target.chatId} name={target.name} />;
    }
}

/** A chat by its name, linked once the engine confirms the thread exists. */
function ChatLink({ chatId, name }: { readonly chatId: ChatId | null; readonly name: string }) {
    const chatsVisible = useAllows({ permission: 'chats.read' });
    const chat = useQuery({
        ...chatQueryOptions(useEngineApi(), chatId ?? ChatId.parse('none')),
        enabled: chatsVisible && chatId !== null,
    });
    if (chat.data === undefined) return <span>{name}</span>;
    return (
        <Link to="/chats/$chatId" params={{ chatId: chat.data.id }}>
            {name}
        </Link>
    );
}

function linkKindLabel(target: TaskLinkTarget): string {
    switch (target.type) {
        case 'chat':
            return m.task_link_chat();
        case 'agent':
            return m.task_link_agent();
        case 'task':
            return m.task_link_task();
    }
}

/** Parent and children, prerequisites and dependants, and the directed links, each from the engine's report. */
function RelationsCard({ task }: { readonly task: ReadTaskDetail }) {
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
        <Card title={m.task_relations_title()}>
            <dl className="grid gap-4 sm:grid-cols-2">
                {origin === null ? null : (
                    <Relation label={m.task_relation_origin()}>
                        <li className="break-words">
                            <Origin task={task} origin={origin} />
                        </li>
                    </Relation>
                )}
                {task.parent === null ? null : (
                    <Relation label={m.task_relation_parent()}>
                        <li>
                            <TaskRefLink taskId={task.parent.taskId} name={task.parent.name} />
                        </li>
                    </Relation>
                )}
                {task.children.length === 0 ? null : (
                    <Relation label={m.task_relation_children()}>
                        {task.children.map((child) => (
                            <li key={child.taskId ?? child.name} className="flex flex-wrap items-center gap-2">
                                <TaskRefLink taskId={child.taskId} name={child.name} />
                                <TaskStateBadge state={child.state} />
                            </li>
                        ))}
                    </Relation>
                )}
                {task.dependsOn.length === 0 ? null : (
                    <Relation label={m.task_relation_depends_on()}>
                        {task.dependsOn.map((dependency) => (
                            <li
                                key={dependency.taskId ?? dependency.name}
                                className="flex flex-wrap items-center gap-2"
                            >
                                <TaskRefLink taskId={dependency.taskId} name={dependency.name} />
                                <Badge
                                    tone={
                                        dependency.state === 'met'
                                            ? 'success'
                                            : dependency.state === 'pending'
                                              ? 'neutral'
                                              : 'danger'
                                    }
                                >
                                    {dependencyLabel(dependency.state)}
                                </Badge>
                            </li>
                        ))}
                    </Relation>
                )}
                {task.blocks.length === 0 ? null : (
                    <Relation label={m.task_relation_blocks()}>
                        {task.blocks.map((dependant) => (
                            <li key={dependant.taskId ?? dependant.name} className="flex flex-wrap items-center gap-2">
                                <TaskRefLink taskId={dependant.taskId} name={dependant.name} />
                                <TaskStateBadge state={dependant.state} />
                            </li>
                        ))}
                    </Relation>
                )}
                {outgoing.length === 0 ? null : (
                    <Relation label={m.task_relation_links_to()}>
                        {outgoing.map((link, index) => (
                            <li key={index} className="break-words">
                                <span className="text-text-muted">{linkKindLabel(link.target)}</span>{' '}
                                <LinkTarget target={link.target} />
                            </li>
                        ))}
                    </Relation>
                )}
                {incoming.length === 0 ? null : (
                    <Relation label={m.task_relation_linked_from()}>
                        {incoming.map((link, index) => (
                            <li key={index} className="break-words">
                                <span className="text-text-muted">{linkKindLabel(link.target)}</span>{' '}
                                <LinkTarget target={link.target} />
                            </li>
                        ))}
                    </Relation>
                )}
            </dl>
        </Card>
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
        return <ChatLink chatId={chatId} name={link?.target.name ?? m.task_origin_chat()} />;
    }
    if (origin.taskId !== null) {
        const name = task.parent?.taskId === origin.taskId ? task.parent.name : m.task_origin_task();
        return <TaskRefLink taskId={origin.taskId} name={name} />;
    }
    if (origin.kind === 'goal') return <span>{m.task_origin_goal()}</span>;
    if (origin.kind === 'engine') return <span>{m.task_origin_engine()}</span>;
    if (origin.kind === 'user') return <span>{origin.text ?? m.task_origin_user()}</span>;
    return <span>{origin.text ?? m.task_state_unknown()}</span>;
}

/** Every occurrence newest first: work cycles, recurring slots, reopenings and retries, each with its runs. */
function OccurrencesCard({ task }: { readonly task: ReadTaskDetail }) {
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
                <p className="text-sm text-text-muted">{m.task_occurrences_empty()}</p>
            ) : (
                <>
                    <ol className="-my-3 flex flex-col divide-y divide-divider">
                        {items.map((occurrence) => (
                            <OccurrenceRow key={occurrence.id} occurrence={occurrence} runsVisible={runsVisible} />
                        ))}
                    </ol>
                    {occurrences.hasNextPage ? (
                        <div className="flex justify-center">
                            <Button
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
    return <Card title={m.task_occurrences_title()}>{body}</Card>;
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
        <li className="flex flex-col gap-1 py-3 text-sm">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">
                    {m.task_occurrence_title({
                        sequence: occurrence.sequence,
                        reason: occurrenceReasonLabel(occurrence.reason),
                    })}
                </span>
                <Badge tone={occurrenceTone(occurrence.state)}>{occurrenceStateLabel(occurrence.state)}</Badge>
                {at === null ? null : <RelativeTime value={new Date(at)} className="text-text-muted" />}
                {occurrence.cycle > 1 ? (
                    <span className="text-text-muted">{m.task_occurrence_cycle({ cycle: occurrence.cycle })}</span>
                ) : null}
            </span>
            {occurrence.summary === null ? null : (
                <span className="break-words text-text-muted">{occurrence.summary}</span>
            )}
            {runsVisible && occurrence.runIds.length > 0 ? (
                <span className="flex flex-wrap gap-x-3">
                    {occurrence.runIds.map((runId, index) => (
                        <Link key={runId} to="/runs/$runId" params={{ runId }}>
                            {occurrence.runIds.length === 1
                                ? m.task_occurrence_run()
                                : m.task_occurrence_run_n({ n: index + 1 })}
                        </Link>
                    ))}
                </span>
            ) : null}
        </li>
    );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

function DateTime({ at }: { readonly at: string }) {
    const locale = useLocale();
    return <time dateTime={at}>{locale.formatDateTime(new Date(at))}</time>;
}

/** Schedule and bookkeeping, shown only where the engine reports a value. */
function DetailsCard({ task }: { readonly task: ReadTaskDetail }) {
    return (
        <Card title={m.task_details_title()}>
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                {task.repeat === null ? null : (
                    <Fact label={m.task_fact_repeat()}>{m.task_repeat_every({ every: task.repeat.text })}</Fact>
                )}
                {task.nextAt === null ? null : (
                    <Fact label={m.task_fact_next()}>
                        <DateTime at={task.nextAt} />
                    </Fact>
                )}
                {task.notBefore === null ? null : (
                    <Fact label={m.task_fact_not_before()}>
                        <DateTime at={task.notBefore} />
                    </Fact>
                )}
                {task.dueAt === null ? null : (
                    <Fact label={m.task_fact_due()}>
                        <DateTime at={task.dueAt} />
                    </Fact>
                )}
                <Fact label={m.task_fact_done_count()}>{task.doneCount}</Fact>
                {task.lastDoneAt === null ? null : (
                    <Fact label={m.task_fact_last_done()}>
                        <DateTime at={task.lastDoneAt} />
                    </Fact>
                )}
                {task.reopened ? <Fact label={m.task_fact_reopened()}>{m.task_reopened_yes()}</Fact> : null}
                <Fact label={m.task_fact_source()}>
                    {task.sourcePath === null ? (
                        <span className="text-text-muted">{m.task_source_engine()}</span>
                    ) : (
                        <span className="font-mono text-xs">{task.sourcePath}</span>
                    )}
                </Fact>
            </dl>
        </Card>
    );
}
