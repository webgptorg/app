import { ChatId, KNOWN_CAPABILITIES, TaskId } from '@ptbk/engine-api';
import type { ReadTaskDetail, ReadTaskOccurrence } from '@ptbk/engine-api';
import {
    Badge,
    Button,
    createDataTableColumnHelper,
    DataTable,
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
import type { DataTableColumnDef, StatusTone } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import {
    Activity,
    AlignLeft,
    CalendarClock,
    Circle,
    CircleCheck,
    CircleDot,
    Flag,
    Hash,
    History as HistoryIcon,
    MessageSquare,
} from 'lucide-react';
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
import { TaskRelations } from './task-relations';
import { occurrenceReasonLabel, occurrenceStateLabel, occurrenceTone, TaskStateBadge, taskTone } from './task-state';
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
            <TaskRelations task={task} />
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
                    <span className="inline-flex h-6 items-center gap-1.5 rounded-pill bg-neutral-soft px-2 text-xs font-medium text-text tabular-nums">
                        <Flag aria-hidden className="size-3 text-text-muted" />
                        {task.priority.text === null
                            ? m.task_priority_short({ rank: task.priority.rank })
                            : m.task_priority_short_text({ rank: task.priority.rank, text: task.priority.text })}
                    </span>
                </Fact>
            ) : null}
            {progress === null ? null : (
                <Fact label={m.task_fact_progress()}>
                    <span className="inline-flex items-center gap-2 tabular-nums">
                        <SubtaskMeter completed={progress.completed} total={progress.total} />
                        {m.task_subtasks_done({ completed: progress.completed, total: progress.total })}
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

/** How far the subtasks are, as a short quiet bar; the words beside it say the same for everyone. */
function SubtaskMeter({ completed, total }: { readonly completed: number; readonly total: number }) {
    const share = Math.min(1, Math.max(0, completed / total));
    return (
        <span aria-hidden="true" className="inline-flex h-1 w-12 overflow-hidden rounded-pill bg-neutral-soft">
            {/* Width through the CSSOM, which the engine's CSP allows; never a style attribute string. */}
            <span className="h-full rounded-pill bg-text-muted" style={{ width: `${String(share * 100)}%` }} />
        </span>
    );
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

const history = createDataTableColumnHelper<ReadTaskOccurrence>();

function historyColumns(runsVisible: boolean): DataTableColumnDef<ReadTaskOccurrence>[] {
    return [
        history.accessor('sequence', {
            header: m.task_history_column_occurrence(),
            enableSorting: false,
            meta: { icon: <Hash className="size-3.5" />, priority: 0 },
            cell: ({ row }) => (
                <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-medium whitespace-nowrap tabular-nums">
                        {m.task_occurrence_title({
                            sequence: row.original.sequence,
                            reason: occurrenceReasonLabel(row.original.reason),
                        })}
                    </span>
                    {row.original.cycle > 1 ? (
                        <span className="text-xs whitespace-nowrap text-text-muted tabular-nums">
                            {m.task_occurrence_cycle({ cycle: row.original.cycle })}
                        </span>
                    ) : null}
                </span>
            ),
        }),
        history.accessor('state', {
            header: m.task_fact_state(),
            enableSorting: false,
            meta: { icon: <CircleDot className="size-3.5" />, priority: 1, trailing: true },
            cell: ({ row }) => (
                <StatusPill tone={occurrenceTone(row.original.state)}>
                    {occurrenceStateLabel(row.original.state)}
                </StatusPill>
            ),
        }),
        history.accessor((occurrence) => occurrence.endedAt ?? occurrence.startedAt ?? occurrence.scheduledFor, {
            id: 'when',
            header: m.task_history_column_when(),
            enableSorting: false,
            meta: { icon: <CalendarClock className="size-3.5" />, priority: 2, numeric: true },
            cell: ({ row }) => {
                const at = row.original.endedAt ?? row.original.startedAt ?? row.original.scheduledFor;
                return at === null ? null : (
                    <RelativeTime value={new Date(at)} className="whitespace-nowrap text-text-muted" />
                );
            },
        }),
        history.accessor('summary', {
            header: m.task_history_column_summary(),
            enableSorting: false,
            meta: { icon: <AlignLeft className="size-3.5" />, priority: 3 },
            cell: ({ row }) => {
                const summary = row.original.summary;
                // Agent and engine words: text only.
                return summary === null ? null : (
                    <span className="line-clamp-2 break-words text-text-muted">{summary}</span>
                );
            },
        }),
        ...(runsVisible
            ? [
                  history.accessor('runIds', {
                      header: m.task_history_column_runs(),
                      enableSorting: false,
                      meta: { icon: <Activity className="size-3.5" />, priority: 4 },
                      cell: ({ row }) => (
                          <span className="flex flex-wrap gap-1">
                              {row.original.runIds.map((runId, index) => (
                                  <EntityChip
                                      key={runId}
                                      kind="run"
                                      id={runId}
                                      name={
                                          row.original.runIds.length === 1
                                              ? m.activity_run_chip()
                                              : m.task_occurrence_run_n({ n: index + 1 })
                                      }
                                  />
                              ))}
                          </span>
                      ),
                  }),
              ]
            : []),
    ];
}

/** Every occurrence newest first, in the shared table: work cycles, recurring slots, reopenings and retries, each with its runs. */
function History({ task }: { readonly task: ReadTaskDetail }) {
    const occurrences = useTaskOccurrences(task.id);
    const runsVisible = useAllows({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' });
    const items = occurrences.data?.pages.flatMap((page) => page.items) ?? [];
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
    } else if (items.length === 0) {
        body = (
            <EmptyState
                variant="inline"
                headingLevel={3}
                icon={<HistoryIcon aria-hidden />}
                title={m.task_occurrences_empty()}
            />
        );
    } else {
        body = (
            <>
                <DataTable<ReadTaskOccurrence>
                    caption={m.task_occurrences_title()}
                    columns={historyColumns(runsVisible)}
                    data={items}
                    getRowId={(occurrence) => occurrence.id}
                    getRowLabel={(occurrence) =>
                        m.task_occurrence_title({
                            sequence: occurrence.sequence,
                            reason: occurrenceReasonLabel(occurrence.reason),
                        })
                    }
                />
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

/** One property: its name quiet on the left, the value beside it. */
function Property({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="grid grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-x-6 py-1.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
            <dt className="text-sm text-text-subtle">{label}</dt>
            <dd className="min-w-0 text-sm break-words">{children}</dd>
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

/** Schedule and bookkeeping as quiet property rows, shown only where the engine reports a value. */
function Details({ task }: { readonly task: ReadTaskDetail }) {
    return (
        <Section title={m.task_details_title()}>
            <dl className="flex max-w-2xl flex-col">
                {task.repeat === null ? null : (
                    <Property label={m.task_fact_repeat()}>{m.task_repeat_every({ every: task.repeat.text })}</Property>
                )}
                {task.nextAt === null ? null : (
                    <Property label={m.task_fact_next()}>
                        <DateTime at={task.nextAt} />
                    </Property>
                )}
                {task.notBefore === null ? null : (
                    <Property label={m.task_fact_not_before()}>
                        <DateTime at={task.notBefore} />
                    </Property>
                )}
                {task.dueAt === null ? null : (
                    <Property label={m.task_fact_due()}>
                        <DateTime at={task.dueAt} />
                    </Property>
                )}
                <Property label={m.task_fact_done_count()}>
                    <span className="tabular-nums">{task.doneCount}</span>
                </Property>
                {task.lastDoneAt === null ? null : (
                    <Property label={m.task_fact_last_done()}>
                        <DateTime at={task.lastDoneAt} />
                    </Property>
                )}
                {task.reopened ? <Property label={m.task_fact_reopened()}>{m.task_reopened_yes()}</Property> : null}
                <Property label={m.task_fact_source()}>
                    {task.sourcePath === null ? (
                        <span className="text-text-muted">{m.task_source_engine()}</span>
                    ) : (
                        <span className="font-mono text-xs">{task.sourcePath}</span>
                    )}
                </Property>
            </dl>
        </Section>
    );
}
