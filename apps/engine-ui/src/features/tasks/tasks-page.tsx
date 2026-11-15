import { AgentId, KNOWN_CAPABILITIES, TASK_KINDS } from '@ptbk/engine-api';
import type { ReadTask, TaskKind } from '@ptbk/engine-api';
import {
    Badge,
    Button,
    createDataTableColumnHelper,
    DataTable,
    FilterBar,
    filterField,
    RelativeTime,
    viewTransitionStyle,
} from '@ptbk/ui';
import type { DataTableColumnDef, DataTableView, FilterBarField } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Bot, CalendarClock, CircleDot, Flag, History, ListTodo } from 'lucide-react';
import { useCallback } from 'react';

import { cx } from '../../app/cx';
import { useDebouncedSearch } from '../../app/debounced-search';
import { readListParam, readOneParam, writeListParam } from '../../app/search-filters';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { agentListQueryOptions } from '../agents/agents-queries';
import { EntityChip } from '../entities/entity-chip';
import { AGENT_LOOK_PARAMS } from '../home/agent-look-params';
import { Page } from '../shell/page';
import { splitTaskName } from './task-name';
import {
    TASK_SECTIONS,
    TASK_STATUS_GROUP_IDS,
    TaskStateBadge,
    taskSection,
    taskSectionLabel,
    taskStatusGroupLabel,
} from './task-state';
import type { TaskStatusGroup } from './task-state';
import { hasTaskFilters, taskListParams } from './task-search';
import type { TaskSearch } from './task-search';
import { useTaskList } from './tasks-queries';

const route = getRouteApi('/tasks/');

/** Supporting work (engine-owned, or system purpose) is muted, as the engine's own views show it. */
export function isSupportingWork(task: Pick<ReadTask, 'kind' | 'purpose'>): boolean {
    return task.kind === 'engine' || task.purpose === 'system';
}

const NO_FILTERS = { q: undefined, status: undefined, agentId: undefined, kind: undefined } as const;

/**
 * The engine's task inventory, read-only, in the engine's own order and grouped into what needs a decision now, what
 * comes next and what is closed. Work changes in chat with Chatter, so the list offers no task actions.
 */
export function TasksPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const runsVisible = useAllows({ capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' });
    const onChange = useCallback(
        (change: Partial<TaskSearch>) => {
            void navigate({ search: (previous) => ({ ...previous, ...change }) });
        },
        [navigate],
    );
    return (
        <Page
            title={m.tasks_title()}
            description={m.tasks_intro()}
            {...(runsVisible
                ? {
                      actions: (
                          <ButtonLink to="/runs" variant="ghost" size="sm">
                              <History aria-hidden className="size-4" />
                              {m.tasks_run_history()}
                          </ButtonLink>
                      ),
                  }
                : {})}
        >
            <TaskInventory search={search} onChange={onChange} />
        </Page>
    );
}

const helper = createDataTableColumnHelper<ReadTask>();

/** The name as a person reads it, the engine's instance stamp quiet beside it, and why it waits when it does. */
function TaskTitle({ task }: { readonly task: ReadTask }) {
    const { readable, stamp } = splitTaskName(task.name);
    const supporting = isSupportingWork(task);
    const why = task.state === 'blocked' || task.state === 'awaiting-user' ? task.stateReason : null;
    return (
        <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
                {/* Names come from Books and agents: React renders them as text. */}
                <Link
                    to="/tasks/$taskId"
                    params={{ taskId: task.id }}
                    title={stamp === null ? undefined : task.name}
                    className={cx(
                        'min-w-0 truncate font-medium hover:underline',
                        supporting ? 'text-text-muted' : 'text-text',
                    )}
                >
                    <span style={viewTransitionStyle('task-title', task.id)}>{readable}</span>
                </Link>
                {stamp === null ? null : (
                    <span className="hidden shrink-0 text-xs text-text-muted tabular-nums sm:inline">{stamp}</span>
                )}
                {task.progress !== null && task.progress.total > 0 ? (
                    <span className="shrink-0 text-xs text-text-muted tabular-nums">
                        {m.task_meta_progress({ completed: task.progress.completed, total: task.progress.total })}
                    </span>
                ) : null}
                {task.kind === 'engine' ? <Badge>{m.task_kind_engine()}</Badge> : null}
                {task.kind !== 'engine' && task.purpose === 'system' ? <Badge>{m.task_purpose_system()}</Badge> : null}
            </span>
            {why === null ? null : <span className="line-clamp-1 text-xs break-words text-text-muted">{why}</span>}
        </span>
    );
}

function TaskOwnerCell({ task }: { readonly task: ReadTask }) {
    if (task.kind === 'engine') {
        const executor = task.executor ?? m.task_owner_engine();
        return (
            <span title={executor} className="block max-w-48 truncate text-text-muted">
                {executor}
            </span>
        );
    }
    if (task.agentId === null) return <span className="text-text-muted">{m.task_owner_unassigned()}</span>;
    return <EntityChip kind="agent" id={task.agentId} name={task.agentName ?? task.agentId} />;
}

function priorityText(task: ReadTask): string | null {
    if (task.priority.rank === 0 && task.priority.text === null) return null;
    const rank = `P${String(task.priority.rank)}`;
    return task.priority.text === null ? rank : `${rank} · ${task.priority.text}`;
}

function columns(): DataTableColumnDef<ReadTask>[] {
    return [
        helper.accessor('name', {
            header: m.tasks_column_name(),
            enableSorting: false,
            meta: { icon: <ListTodo className="size-3.5" />, priority: 0 },
            cell: ({ row }) => <TaskTitle task={row.original} />,
        }),
        helper.accessor('state', {
            header: m.task_fact_state(),
            enableSorting: false,
            meta: { icon: <CircleDot className="size-3.5" />, priority: 1, trailing: true },
            cell: ({ row }) => <TaskStateBadge state={row.original.state} />,
        }),
        helper.accessor('agentName', {
            id: 'agent',
            header: m.task_fact_agent(),
            enableSorting: false,
            meta: { icon: <Bot className="size-3.5" />, priority: 2 },
            cell: ({ row }) => <TaskOwnerCell task={row.original} />,
        }),
        helper.accessor('priority', {
            header: m.task_fact_priority(),
            enableSorting: false,
            meta: { icon: <Flag className="size-3.5" />, priority: 3 },
            cell: ({ row }) => {
                const text = priorityText(row.original);
                return text === null ? null : <span className="text-text-muted tabular-nums">{text}</span>;
            },
        }),
        helper.accessor('updatedAt', {
            header: m.tasks_column_updated(),
            enableSorting: false,
            meta: { icon: <CalendarClock className="size-3.5" />, priority: 4, numeric: true },
            cell: ({ row }) => (
                <RelativeTime value={new Date(row.original.updatedAt)} className="whitespace-nowrap text-text-muted" />
            ),
        }),
    ];
}

function TaskInventory({
    search,
    onChange,
}: {
    readonly search: TaskSearch;
    readonly onChange: (change: Partial<TaskSearch>) => void;
}) {
    const list = useTaskList(taskListParams(search));
    const tasks = list.data?.pages.flatMap((page) => page.items) ?? [];
    const filtered = hasTaskFilters(search);
    const clear = () => {
        onChange(NO_FILTERS);
    };
    return (
        <div className="flex flex-col gap-4">
            <DataTable<ReadTask>
                caption={m.tasks_title()}
                columns={columns()}
                data={tasks}
                getRowId={(task) => task.id}
                getRowLabel={(task) => splitTaskName(task.name).readable}
                loading={list.isPending}
                fetching={list.isFetching && !list.isPending && !list.isFetchingNextPage}
                {...(list.isError
                    ? {
                          error: {
                              message: m.tasks_load_failed(),
                              onRetry: () => {
                                  void list.refetch();
                              },
                              retrying: list.isFetching,
                          },
                      }
                    : {})}
                empty={
                    filtered
                        ? {
                              title: m.tasks_no_results(),
                              description: m.tasks_no_results_hint(),
                              action: <Button onClick={clear}>{m.tasks_clear_filters()}</Button>,
                          }
                        : { title: m.tasks_empty_title(), description: m.tasks_empty_body() }
                }
                groups={{
                    groups: TASK_SECTIONS.map((section) => ({ id: section, label: taskSectionLabel(section) })),
                    getGroupId: (task) => taskSection(task.state),
                }}
                toolbar={(view) => <TaskFilters view={view} search={search} onChange={onChange} onClear={clear} />}
            />
            {list.hasNextPage ? (
                <div className="flex justify-center">
                    <Button
                        variant="ghost"
                        onClick={() => {
                            void list.fetchNextPage();
                        }}
                        loading={list.isFetchingNextPage}
                    >
                        {m.tasks_show_more()}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

/** Every filter lives in the URL, so a reload or a shared link restores the view. */
function TaskFilters({
    view,
    search,
    onChange,
    onClear,
}: {
    readonly view: DataTableView;
    readonly search: TaskSearch;
    readonly onChange: (change: Partial<TaskSearch>) => void;
    readonly onClear: () => void;
}) {
    const [text, setText] = useDebouncedSearch(search.q, (q) => {
        onChange({ q });
    });
    const agents = useQuery(agentListQueryOptions(useEngineApi(), AGENT_LOOK_PARAMS));
    const fields: FilterBarField[] = [
        filterField.multiEnum<TaskStatusGroup>({
            id: 'status',
            label: m.tasks_filter_status(),
            icon: <CircleDot className="size-3.5" />,
            options: TASK_STATUS_GROUP_IDS.map((group) => ({ value: group, label: taskStatusGroupLabel(group) })),
            value: readListParam(search.status, TASK_STATUS_GROUP_IDS),
            onChange: (value) => {
                onChange({ status: writeListParam(value, TASK_STATUS_GROUP_IDS) });
            },
        }),
        filterField.entity<string>({
            id: 'agent',
            label: m.tasks_filter_agent(),
            icon: <Bot className="size-3.5" />,
            multiple: false,
            options: (agents.data?.items ?? []).map((agent) => ({
                value: agent.id,
                label: agent.name,
                icon: <AgentAvatar name={agent.name} agentKey={agent.id} profile={agent.profile} size="2xs" />,
            })),
            value: readOneParam(search.agentId),
            onChange: (value) => {
                // An agent beyond the first page stays selected by its ID from the URL until it is removed.
                const picked = value.at(-1);
                onChange({ agentId: picked === undefined ? undefined : AgentId.safeParse(picked).data });
            },
        }),
        filterField.enum<TaskKind>({
            id: 'kind',
            label: m.tasks_filter_kind(),
            icon: <ListTodo className="size-3.5" />,
            options: TASK_KINDS.map((kind) => ({
                value: kind,
                label: kind === 'engine' ? m.tasks_filter_kind_engine() : m.tasks_filter_kind_ordinary(),
            })),
            value: search.kind,
            onChange: (value) => {
                onChange({ kind: value });
            },
        }),
    ];
    return (
        <FilterBar
            {...view}
            label={m.tasks_filters()}
            search={{ label: m.tasks_search(), value: text, onChange: setText, maxLength: 256 }}
            fields={fields}
            onClear={() => {
                setText('');
                onClear();
            }}
        />
    );
}
