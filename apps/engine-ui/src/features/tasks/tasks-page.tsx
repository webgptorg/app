import { KNOWN_CAPABILITIES, TASK_KINDS } from '@ptbk/engine-api';
import type { ReadTask } from '@ptbk/engine-api';
import { Badge, Button, Card, EmptyState, ErrorState, LegacyFilterBar, RelativeTime, Skeleton } from '@ptbk/ui';
import type { LegacyFilterBarFilter } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { useDebouncedSearch } from '../../app/debounced-search';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { agentListQueryOptions } from '../agents/agents-queries';
import { Page } from '../shell/page';
import {
    TASK_SECTIONS,
    TASK_STATUS_GROUP_IDS,
    TaskStateBadge,
    taskSection,
    taskSectionLabel,
    taskStatusGroupLabel,
} from './task-state';
import type { TaskSection } from './task-state';
import { hasTaskFilters, selectedGroups, taskListParams } from './task-search';
import type { TaskSearch } from './task-search';
import { useTaskList } from './tasks-queries';

const route = getRouteApi('/tasks/');
// The first page of agents fills the agent filter; a task of another agent still shows, by its own name.
const AGENT_FILTER_LIMIT = 100;

/** Supporting work (engine-owned, or system purpose) is muted, as the engine's own views show it. */
export function isSupportingWork(task: Pick<ReadTask, 'kind' | 'purpose'>): boolean {
    return task.kind === 'engine' || task.purpose === 'system';
}

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
                          <Link to="/runs" variant="standalone" className="text-sm">
                              {m.tasks_run_history()}
                          </Link>
                      ),
                  }
                : {})}
        >
            <div className="flex flex-col gap-4">
                <TaskFilters search={search} onChange={onChange} />
                <TaskInventory
                    search={search}
                    onClear={() => {
                        onChange({ q: undefined, status: undefined, agentId: undefined, kind: undefined });
                    }}
                />
            </div>
        </Page>
    );
}

function TaskInventory({ search, onClear }: { readonly search: TaskSearch; readonly onClear: () => void }) {
    const list = useTaskList(taskListParams(search));
    if (list.isPending) {
        return (
            <div className="flex flex-col gap-3" aria-busy="true">
                <Skeleton shape="block" className="h-20 w-full" />
                <Skeleton shape="block" className="h-20 w-full" />
            </div>
        );
    }
    if (list.isError) {
        return (
            <ErrorState
                message={m.tasks_load_failed()}
                onRetry={() => {
                    void list.refetch();
                }}
                retrying={list.isFetching}
            />
        );
    }
    const tasks = list.data.pages.flatMap((page) => page.items);
    if (tasks.length === 0) {
        return hasTaskFilters(search) ? (
            <EmptyState
                title={m.tasks_no_results()}
                description={m.tasks_no_results_hint()}
                action={<Button onClick={onClear}>{m.tasks_clear_filters()}</Button>}
            />
        ) : (
            <EmptyState title={m.tasks_empty_title()} description={m.tasks_empty_body()} />
        );
    }
    const sections = new Map<TaskSection, ReadTask[]>();
    for (const task of tasks) {
        const section = taskSection(task.state);
        sections.set(section, [...(sections.get(section) ?? []), task]);
    }
    return (
        <div className="flex flex-col gap-4">
            {TASK_SECTIONS.map((section) => {
                const items = sections.get(section);
                if (items === undefined) return null;
                return (
                    <Card key={section} title={taskSectionLabel(section)}>
                        <ul className="-my-3 flex flex-col divide-y divide-divider">
                            {items.map((task) => (
                                <TaskRow key={task.id} task={task} />
                            ))}
                        </ul>
                    </Card>
                );
            })}
            {list.hasNextPage ? (
                <div className="flex justify-center">
                    <Button
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

/** Name, state and the few facts that decide what to do next; everything else waits on the detail page. */
function TaskRow({ task }: { readonly task: ReadTask }) {
    const supporting = isSupportingWork(task);
    return (
        <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className={cx('flex min-w-0 flex-col gap-1', supporting && 'text-text-muted')}>
                {/* Names come from Books and agents: React renders them as text. */}
                <Link
                    to="/tasks/$taskId"
                    params={{ taskId: task.id }}
                    variant="standalone"
                    className={cx('font-medium break-words', supporting && 'text-text-muted')}
                >
                    {task.name}
                </Link>
                <TaskMeta task={task} />
                {task.stateReason !== null && (task.state === 'blocked' || task.state === 'awaiting-user') ? (
                    <span className="line-clamp-2 text-sm break-words text-text-muted">{task.stateReason}</span>
                ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
                {task.kind === 'engine' ? <Badge>{m.task_kind_engine()}</Badge> : null}
                {task.kind !== 'engine' && task.purpose === 'system' ? <Badge>{m.task_purpose_system()}</Badge> : null}
                <TaskStateBadge state={task.state} />
            </div>
        </li>
    );
}

function TaskMeta({ task }: { readonly task: ReadTask }) {
    const parts: ReactNode[] = [];
    if (task.kind === 'engine' && task.executor !== null) parts.push(task.executor);
    else if (task.agentName !== null) parts.push(task.agentName);
    if (task.parent !== null) parts.push(m.task_meta_part_of({ name: task.parent.name }));
    if (task.progress !== null && task.progress.total > 0) {
        parts.push(m.task_meta_progress({ completed: task.progress.completed, total: task.progress.total }));
    }
    if (task.repeat !== null) parts.push(m.task_meta_repeats({ every: task.repeat.text }));
    if (task.nextAt !== null && task.state !== 'done') {
        parts.push(
            <span key="next">
                {m.task_meta_next()} <RelativeTime value={new Date(task.nextAt)} />
            </span>,
        );
    }
    if (task.dueAt !== null) {
        parts.push(
            <span key="due">
                {m.task_meta_due()} <RelativeTime value={new Date(task.dueAt)} />
            </span>,
        );
    }
    if (parts.length === 0) return null;
    return (
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-text-muted">
            {parts.map((part, index) => (
                <span key={index} className="break-words">
                    {part}
                </span>
            ))}
        </span>
    );
}

/** Every filter lives in the URL, so a reload or a shared link restores the view. */
function TaskFilters({
    search,
    onChange,
}: {
    readonly search: TaskSearch;
    readonly onChange: (change: Partial<TaskSearch>) => void;
}) {
    const [text, setText] = useDebouncedSearch(search.q, (q) => {
        onChange({ q });
    });
    const agents = useQuery(agentListQueryOptions(useEngineApi(), { limit: AGENT_FILTER_LIMIT, sort: 'name' }));
    const items = agents.data?.items ?? [];
    const agentOptions = items.map((agent) => ({ value: agent.id, label: agent.name }));
    const agentId = search.agentId;
    if (agentId !== undefined && !items.some((agent) => agent.id === agentId))
        agentOptions.unshift({ value: agentId, label: agentId });
    const filters: LegacyFilterBarFilter[] = [
        {
            kind: 'multi',
            id: 'status',
            label: m.tasks_filter_status(),
            options: TASK_STATUS_GROUP_IDS.map((group) => ({ value: group, label: taskStatusGroupLabel(group) })),
            value: [...selectedGroups(search)],
            onChange: (value) => {
                const next = TASK_STATUS_GROUP_IDS.filter((group) => value.includes(group));
                onChange({ status: next.length === 0 ? undefined : next.join(',') });
            },
        },
        {
            kind: 'select',
            id: 'agent',
            label: m.tasks_filter_agent(),
            allLabel: m.tasks_filter_all_agents(),
            options: agentOptions,
            value: agentId,
            onChange: (value) => {
                onChange({
                    agentId: items.find((agent) => agent.id === value)?.id ?? (value === agentId ? agentId : undefined),
                });
            },
        },
        {
            kind: 'select',
            id: 'kind',
            label: m.tasks_filter_kind(),
            allLabel: m.tasks_filter_all_kinds(),
            options: TASK_KINDS.map((kind) => ({
                value: kind,
                label: kind === 'engine' ? m.tasks_filter_kind_engine() : m.tasks_filter_kind_ordinary(),
            })),
            value: search.kind,
            onChange: (value) => {
                onChange({ kind: TASK_KINDS.find((kind) => kind === value) });
            },
        },
    ];
    return (
        <LegacyFilterBar
            label={m.tasks_filters()}
            search={{ label: m.tasks_search(), value: text, onChange: setText, maxLength: 256 }}
            filters={filters}
            onClear={() => {
                setText('');
                onChange({ q: undefined, status: undefined, agentId: undefined, kind: undefined });
            }}
        />
    );
}
