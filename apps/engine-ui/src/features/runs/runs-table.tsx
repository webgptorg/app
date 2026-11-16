import { RUN_SOURCES, RUN_STATUSES } from '@ptbk/engine-api';
import type { AgentId, ReadAgent, ReadRun } from '@ptbk/engine-api';
import {
    Avatar,
    Button,
    createDataTableColumnHelper,
    DataTable,
    EntityChip,
    FilterBar,
    filterField,
    RelativeTime,
    StatusDot,
    viewTransitionStyle,
} from '@ptbk/ui';
import type { DataTableColumnDef, FilterBarField, SortingState } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink } from '@tanstack/react-router';
import { Activity, Bot, CalendarClock, CircleDot, Coins, Hash, Timer, Zap } from 'lucide-react';
import { useEffect, useMemo } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { isInvalidCursor } from '../../app/list-errors';
import { useAllows } from '../../app/registry/use-visible-features';
import { readListParam, readOneParam, readRangeParams, writeListParam } from '../../app/search-filters';
import { m } from '../../paraglide/messages';
import { safeImageSource } from '../../security/safe-url';
import { agentListQueryOptions } from '../agents/agents-queries';
import { agentColor } from '../chat/references/agent-color';
import { useRunRowActions } from './run-actions';
import { RunCost, RunDuration, runTitle } from './run-format';
import { hasRunFilters, runListParams } from './run-search';
import type { RunSearch } from './run-search';
import { runSourceLabel } from './run-source';
import { RunStatusPill, runStatusLabel, runStatusTone } from './run-status';
import { runListQueryOptions, useRunList } from './runs-queries';

const NO_RUNS: readonly ReadRun[] = [];
const NO_AGENTS: readonly ReadAgent[] = [];
// The first page of agents fills the agent filter; a run of another agent still shows, by its own name.
const AGENT_FILTER_LIMIT = 100;
export const RUN_COLUMNS_STORAGE_KEY = 'ptbk.runs.columns';

const ICON = 'size-3.5';

interface AgentLook {
    readonly tint: string;
    readonly src: string | null;
}

/** An agent's avatar and colour, from its profile when the agent list has it, else from its ID. */
function agentLook(agentId: string, agents: ReadonlyMap<string, ReadAgent>): AgentLook {
    const profile = agents.get(agentId)?.profile;
    const avatarUrl = profile?.avatarUrl ?? null;
    return {
        tint: agentColor(profile?.color, agentId),
        src: avatarUrl === null ? null : safeImageSource(avatarUrl),
    };
}

/**
 * The engine's first page of agents by ID, for their faces and colours and the agent filter. Cells read it themselves
 * (one cached query), so the columns stay the same objects when it arrives and rows are not mounted again.
 */
function useAgents(enabled: boolean): {
    readonly list: readonly ReadAgent[];
    readonly byId: ReadonlyMap<string, ReadAgent>;
} {
    const allowed = useAllows({ permission: 'agents.read' });
    const query = useQuery({
        ...agentListQueryOptions(useEngineApi(), { limit: AGENT_FILTER_LIMIT, sort: 'name' }),
        enabled: enabled && allowed,
    });
    const list = query.data?.items ?? NO_AGENTS;
    const byId = useMemo(() => new Map(list.map((agent) => [agent.id, agent])), [list]);
    return { list, byId };
}

interface RunColumnOptions {
    /** The global list; on an agent's tab the agent column is redundant and links return to the tab. */
    readonly acrossAgents: boolean;
    /** Off when no run on the page reports a cost, so a column of dashes does not take the room. */
    readonly cost: boolean;
}

function useRunColumns({ acrossAgents, cost }: RunColumnOptions): DataTableColumnDef<ReadRun>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<ReadRun>();
        const columns: DataTableColumnDef<ReadRun>[] = [
            // Titles come from agents and whoever started the run: React renders them as text.
            column.accessor((run) => runTitle(run), {
                id: 'title',
                header: m.runs_column_title(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0, icon: <Hash className={ICON} /> },
                cell: ({ row }) => (
                    <span className="flex min-w-0 flex-col items-start gap-0.5">
                        <Link
                            to="/runs/$runId"
                            params={{ runId: row.original.id }}
                            {...(acrossAgents ? {} : { search: { from: 'agent' } })}
                            variant="standalone"
                            className="line-clamp-2 font-medium break-words text-text"
                        >
                            <span style={viewTransitionStyle('run-title', row.original.id)}>
                                {runTitle(row.original)}
                            </span>
                        </Link>
                        <RunNow run={row.original} />
                        {row.original.retryOf === null ? null : (
                            <span className="text-xs text-text-muted">{m.run_fact_retry_of_link()}</span>
                        )}
                    </span>
                ),
            }),
            column.accessor('status', {
                header: m.runs_column_status(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 1, icon: <CircleDot className={ICON} /> },
                cell: ({ row }) => (
                    <RunStatusPill status={row.original.status} cancelling={row.original.cancelRequestedAt !== null} />
                ),
            }),
        ];
        if (acrossAgents) {
            columns.push(
                column.accessor((run) => run.agentName ?? run.agentId, {
                    id: 'agent',
                    header: m.runs_column_agent(),
                    enableSorting: false,
                    meta: { priority: 3, icon: <Bot className={ICON} /> },
                    cell: ({ row }) => <RunAgent run={row.original} />,
                }),
            );
        }
        columns.push(
            column.accessor('source', {
                header: m.runs_column_source(),
                enableSorting: false,
                meta: { priority: 4, icon: <Zap className={ICON} /> },
                cell: ({ row }) => runSourceLabel(row.original.source),
            }),
            column.accessor('queuedAt', {
                header: m.runs_column_queued(),
                meta: { priority: 2, trailing: true, numeric: true, icon: <CalendarClock className={ICON} /> },
                cell: ({ row }) => (
                    <RelativeTime value={new Date(row.original.queuedAt)} className="whitespace-nowrap" />
                ),
            }),
            column.accessor((run) => run.usage?.durationMs ?? null, {
                id: 'duration',
                header: m.runs_column_duration(),
                enableSorting: false,
                meta: { priority: 5, numeric: true, icon: <Timer className={ICON} /> },
                cell: ({ row }) => <RunDuration run={row.original} />,
            }),
        );
        if (cost) {
            columns.push(
                column.accessor((run) => run.usage?.cost?.amount ?? null, {
                    id: 'cost',
                    header: m.runs_column_cost(),
                    enableSorting: false,
                    meta: { priority: 6, numeric: true, icon: <Coins className={ICON} /> },
                    cell: ({ row }) => <RunCost cost={row.original.usage?.cost} />,
                }),
            );
        }
        return columns;
    }, [acrossAgents, cost]);
}

/** The run's agent as a chip in its colour, linking to the agent; the name is a text node. */
function RunAgent({ run }: { readonly run: ReadRun }) {
    const look = agentLook(run.agentId, useAgents(true).byId);
    const name = run.agentName ?? run.agentId;
    return (
        <EntityChip
            label={name}
            tone="agent"
            tint={look.tint}
            leading={<Avatar name={name} src={look.src} tint={look.tint} size="2xs" />}
            render={({ children, ...props }) => (
                <RouterLink to="/agents/$agentId" params={{ agentId: run.agentId }} {...props}>
                    {children}
                </RouterLink>
            )}
        />
    );
}

/** What a running run's agent says it is doing, under its title, so the list shows work moving. */
function RunNow({ run }: { readonly run: ReadRun }) {
    const now = run.progress?.now?.trim() ?? '';
    if (run.status !== 'running' || now === '') return null;
    return <span className="line-clamp-1 text-xs break-words text-text-muted">{now}</span>;
}

export interface RunsTableProps {
    readonly search: RunSearch;
    /** Applies a change to the URL, which is the only place the filters, order and page live. */
    readonly onSearchChange: (change: Partial<RunSearch>, options?: { readonly replace?: boolean }) => void;
    /** On an agent's tab: only that agent's runs, without the agent column and filter. */
    readonly agentId?: AgentId;
}

/** The engine's order is newest first; the URL only says so when a reader turned it around. */
function sortingOf(search: RunSearch): SortingState {
    return [{ id: 'queuedAt', desc: search.sort !== 'queuedAt' }];
}

/** The runs timeline, global or for one agent: every filter, the order and each page are applied by the engine. */
export function RunsTable({ search, onSearchChange, agentId }: RunsTableProps) {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const { storage } = useBrowser();
    const params = runListParams(search, agentId);
    const list = useRunList(params);
    const scope = agentId === undefined ? 'global' : 'agent';
    const items = list.data?.items ?? NO_RUNS;
    const agents = useAgents(scope === 'global');
    const columns = useRunColumns({
        acrossAgents: scope === 'global',
        cost: items.some((run) => run.usage?.cost !== null && run.usage?.cost !== undefined),
    });
    const rowActions = useRunRowActions();
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        onSearchChange({ cursor });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) onSearchChange({ cursor: undefined }, { replace: true });
    }, [invalidCursor, onSearchChange]);

    const filtered = hasRunFilters(search, scope);
    const filter = (change: Partial<RunSearch>) => {
        onSearchChange({ cursor: undefined, ...change });
    };
    const clear = () => {
        filter({ status: undefined, source: undefined, from: undefined, to: undefined, agentId: undefined });
    };
    const clearButton = <Button onClick={clear}>{m.runs_clear_filters()}</Button>;
    const fields = runFilterFields({ search, scope, agents: agents.list, agentsById: agents.byId, onChange: filter });

    return (
        <DataTable
            caption={m.runs_title()}
            columns={columns}
            data={items}
            getRowId={(run) => run.id}
            getRowLabel={(run) => runTitle(run)}
            visibilityStorage={{ storage, key: RUN_COLUMNS_STORAGE_KEY }}
            sorting={sortingOf(search)}
            onSortingChange={(next) => {
                const [first] = next;
                filter({ sort: first !== undefined && !first.desc ? 'queuedAt' : undefined });
            }}
            sortingRemoval={false}
            toolbar={(view) => <FilterBar {...view} label={m.runs_filters()} fields={fields} onClear={clear} />}
            rowActions={rowActions}
            page={paging.page}
            onPageChange={paging.onPageChange}
            onPageIntent={(cursor, direction) => {
                if (direction !== 'next') return;
                queryClient.query(runListQueryOptions(engineApi, { ...params, cursor })).catch(() => undefined);
            }}
            loading={list.isPending}
            fetching={list.isFetching && !list.isPending}
            {...(list.isError && !invalidCursor
                ? {
                      error: {
                          message: m.runs_load_failed(),
                          onRetry: () => {
                              void list.refetch();
                          },
                          retrying: list.isFetching,
                      },
                  }
                : {})}
            empty={
                filtered
                    ? { title: m.runs_no_results(), description: m.runs_no_results_hint(), action: clearButton }
                    : {
                          icon: <Activity />,
                          title: m.runs_empty_title(),
                          description: scope === 'agent' ? m.runs_empty_agent_body() : m.runs_empty_body(),
                      }
            }
        />
    );
}

interface RunFilterInput {
    readonly search: RunSearch;
    readonly scope: 'global' | 'agent';
    readonly agents: readonly ReadAgent[];
    readonly agentsById: ReadonlyMap<string, ReadAgent>;
    readonly onChange: (change: Partial<RunSearch>) => void;
}

/** Every field reads from and writes to the search params, so a reload or a shared link restores the view. */
function runFilterFields({ search, scope, agents, agentsById, onChange }: RunFilterInput): readonly FilterBarField[] {
    return [
        filterField.multiEnum({
            id: 'status',
            label: m.runs_filter_status(),
            icon: <CircleDot className={ICON} />,
            options: RUN_STATUSES.map((status) => ({
                value: status,
                label: runStatusLabel(status),
                icon: <StatusDot tone={runStatusTone(status)} />,
            })),
            value: readListParam(search.status, RUN_STATUSES),
            onChange: (value) => {
                onChange({ status: writeListParam(value, RUN_STATUSES) });
            },
        }),
        ...(scope === 'global'
            ? [
                  // The engine filters by one agent, so picking another replaces it.
                  filterField.entity({
                      id: 'agent',
                      label: m.runs_filter_agent(),
                      icon: <Bot className={ICON} />,
                      multiple: false,
                      options: agents.map((agent) => {
                          const look = agentLook(agent.id, agentsById);
                          return {
                              value: agent.id,
                              label: agent.name,
                              icon: <Avatar name={agent.name} src={look.src} tint={look.tint} size="2xs" />,
                          };
                      }),
                      value: readOneParam(search.agentId),
                      onChange: ([picked]) => {
                          onChange({ agentId: picked === undefined ? undefined : agentsById.get(picked)?.id });
                      },
                  }),
              ]
            : []),
        filterField.enum({
            id: 'source',
            label: m.runs_filter_source(),
            icon: <Zap className={ICON} />,
            options: RUN_SOURCES.map((source) => ({ value: source, label: runSourceLabel(source) })),
            value: search.source,
            onChange: (source) => {
                onChange({ source });
            },
        }),
        filterField.dateRange({
            id: 'queued',
            label: m.runs_column_queued(),
            icon: <CalendarClock className={ICON} />,
            value: readRangeParams(search),
            onChange: ({ from, to }) => {
                onChange({ from, to });
            },
        }),
    ];
}
