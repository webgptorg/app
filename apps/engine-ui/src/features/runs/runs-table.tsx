import { RUN_SOURCES, RUN_STATUSES } from '@ptbk/engine-api';
import type { AgentId, ReadRun } from '@ptbk/engine-api';
import { Button, Checkbox, createDataTableColumnHelper, DataTable, Field, Input, RelativeTime, Select } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { isInvalidCursor } from '../../app/list-errors';
import { m } from '../../paraglide/messages';
import { agentListQueryOptions } from '../agents/agents-queries';
import { useRunRowActions } from './run-actions';
import { RunCost, RunDuration, runTitle } from './run-format';
import { runSourceLabel } from './run-source';
import { hasRunFilters, runListParams, selectedStatuses } from './run-search';
import type { RunSearch } from './run-search';
import { RunStatusBadge, runStatusLabel } from './run-status';
import { runListQueryOptions, useRunList } from './runs-queries';

const NO_RUNS: readonly ReadRun[] = [];
// The first page of agents fills the agent filter; a run of another agent still shows, by its own name.
const AGENT_FILTER_LIMIT = 100;
export const RUN_COLUMNS_STORAGE_KEY = 'ptbk.runs.columns';

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
            column.accessor('status', {
                header: m.runs_column_status(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0 },
                cell: ({ row }) => (
                    <RunStatusBadge status={row.original.status} cancelling={row.original.cancelRequestedAt !== null} />
                ),
            }),
            // Titles come from agents and whoever started the run: React renders them as text.
            column.accessor((run) => runTitle(run), {
                id: 'title',
                header: m.runs_column_title(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 1 },
                cell: ({ row }) => (
                    <span className="flex flex-col items-start gap-0.5">
                        <Link
                            to="/runs/$runId"
                            params={{ runId: row.original.id }}
                            {...(acrossAgents ? {} : { search: { from: 'agent' } })}
                            variant="standalone"
                            className="line-clamp-2 break-words"
                        >
                            {runTitle(row.original)}
                        </Link>
                        <RunNow run={row.original} />
                        {row.original.retryOf === null ? null : (
                            <span className="text-xs text-text-muted">{m.run_fact_retry_of_link()}</span>
                        )}
                    </span>
                ),
            }),
        ];
        if (acrossAgents) {
            columns.push(
                column.accessor((run) => run.agentName ?? run.agentId, {
                    id: 'agent',
                    header: m.runs_column_agent(),
                    enableSorting: false,
                    meta: { priority: 3 },
                    cell: ({ row }) => (
                        <Link to="/agents/$agentId" params={{ agentId: row.original.agentId }} className="break-words">
                            {row.original.agentName ?? row.original.agentId}
                        </Link>
                    ),
                }),
            );
        }
        columns.push(
            column.accessor('source', {
                header: m.runs_column_source(),
                enableSorting: false,
                meta: { priority: 4 },
                cell: ({ row }) => runSourceLabel(row.original.source),
            }),
            column.accessor('queuedAt', {
                header: m.runs_column_queued(),
                enableSorting: false,
                meta: { priority: 2 },
                cell: ({ row }) => (
                    <RelativeTime value={new Date(row.original.queuedAt)} className="whitespace-nowrap" />
                ),
            }),
            column.accessor((run) => run.usage?.durationMs ?? null, {
                id: 'duration',
                header: m.runs_column_duration(),
                enableSorting: false,
                meta: { priority: 5 },
                cell: ({ row }) => <RunDuration run={row.original} />,
            }),
        );
        if (cost) {
            columns.push(
                column.accessor((run) => run.usage?.cost?.amount ?? null, {
                    id: 'cost',
                    header: m.runs_column_cost(),
                    enableSorting: false,
                    meta: { priority: 6 },
                    cell: ({ row }) => <RunCost cost={row.original.usage?.cost} />,
                }),
            );
        }
        return columns;
    }, [acrossAgents, cost]);
}

/** What a running run's agent says it is doing, under its title, so the list shows work moving. */
function RunNow({ run }: { readonly run: ReadRun }) {
    const now = run.progress?.now?.trim() ?? '';
    if (run.status !== 'running' || now === '') return null;
    return <span className="line-clamp-1 text-xs break-words text-text-muted">{now}</span>;
}

export interface RunsTableProps {
    readonly search: RunSearch;
    /** Applies a change to the URL, which is the only place the filters and page live. */
    readonly onSearchChange: (change: Partial<RunSearch>, options?: { readonly replace?: boolean }) => void;
    /** On an agent's tab: only that agent's runs, without the agent column and filter. */
    readonly agentId?: AgentId;
}

/** The runs timeline, global or for one agent: every filter and page is applied by the engine, newest first. */
export function RunsTable({ search, onSearchChange, agentId }: RunsTableProps) {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const { storage } = useBrowser();
    const params = runListParams(search, agentId);
    const list = useRunList(params);
    const scope = agentId === undefined ? 'global' : 'agent';
    const items = list.data?.items ?? NO_RUNS;
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

    return (
        <div className="flex flex-col gap-4">
            <RunFilters search={search} scope={scope} onChange={filter} onClear={clear} filtered={filtered} />
            <DataTable
                caption={m.runs_title()}
                columns={columns}
                data={items}
                getRowId={(run) => run.id}
                getRowLabel={(run) => runTitle(run)}
                visibilityStorage={{ storage, key: RUN_COLUMNS_STORAGE_KEY }}
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
                              title: m.runs_empty_title(),
                              description: scope === 'agent' ? m.runs_empty_agent_body() : m.runs_empty_body(),
                          }
                }
            />
        </div>
    );
}

interface RunFiltersProps {
    readonly search: RunSearch;
    readonly scope: 'global' | 'agent';
    readonly onChange: (change: Partial<RunSearch>) => void;
    readonly onClear: () => void;
    readonly filtered: boolean;
}

function choice<T extends string>(value: string, known: readonly T[]): T | undefined {
    return known.find((candidate) => candidate === value);
}

/** Every control reads from and writes to the search params, so a reload or a shared link restores the view. */
function RunFilters({ search, scope, onChange, onClear, filtered }: RunFiltersProps) {
    const statuses = selectedStatuses(search);
    const toggleStatus = (status: (typeof RUN_STATUSES)[number], on: boolean) => {
        const next = RUN_STATUSES.filter((candidate) => (candidate === status ? on : statuses.has(candidate)));
        onChange({ status: next.length === 0 ? undefined : next.join(',') });
    };
    return (
        <div role="search" aria-label={m.runs_filters()} className="flex flex-col gap-3">
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
                <legend className="mb-1 text-sm font-medium">{m.runs_filter_status()}</legend>
                {RUN_STATUSES.map((status) => (
                    <Checkbox
                        key={status}
                        label={runStatusLabel(status)}
                        checked={statuses.has(status)}
                        onChange={(event) => {
                            toggleStatus(status, event.target.checked);
                        }}
                    />
                ))}
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {scope === 'global' ? <AgentFilter search={search} onChange={onChange} /> : null}
                <Field label={m.runs_filter_source()}>
                    {(control) => (
                        <Select
                            {...control}
                            value={search.source ?? ''}
                            onChange={(event) => {
                                onChange({ source: choice(event.target.value, RUN_SOURCES) });
                            }}
                        >
                            <option value="">{m.runs_filter_all_sources()}</option>
                            {RUN_SOURCES.map((source) => (
                                <option key={source} value={source}>
                                    {runSourceLabel(source)}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
                <Field label={m.runs_filter_from()}>
                    {(control) => (
                        <Input
                            {...control}
                            type="date"
                            value={search.from ?? ''}
                            {...(search.to === undefined ? {} : { max: search.to })}
                            onChange={(event) => {
                                onChange({ from: event.target.value === '' ? undefined : event.target.value });
                            }}
                        />
                    )}
                </Field>
                <Field label={m.runs_filter_to()}>
                    {(control) => (
                        <Input
                            {...control}
                            type="date"
                            value={search.to ?? ''}
                            {...(search.from === undefined ? {} : { min: search.from })}
                            onChange={(event) => {
                                onChange({ to: event.target.value === '' ? undefined : event.target.value });
                            }}
                        />
                    )}
                </Field>
            </div>
            {filtered ? (
                <div>
                    <Button variant="ghost" size="sm" onClick={onClear}>
                        {m.runs_clear_filters()}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

function AgentFilter({ search, onChange }: Pick<RunFiltersProps, 'search' | 'onChange'>) {
    const agents = useQuery(agentListQueryOptions(useEngineApi(), { limit: AGENT_FILTER_LIMIT, sort: 'name' }));
    const items = agents.data?.items ?? [];
    const known = search.agentId === undefined || items.some((agent) => agent.id === search.agentId);
    return (
        <Field label={m.runs_filter_agent()}>
            {(control) => (
                <Select
                    {...control}
                    value={search.agentId ?? ''}
                    onChange={(event) => {
                        onChange({ agentId: items.find((agent) => agent.id === event.target.value)?.id });
                    }}
                >
                    <option value="">{m.runs_filter_all_agents()}</option>
                    {known ? null : <option value={search.agentId}>{search.agentId}</option>}
                    {items.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                            {agent.name}
                        </option>
                    ))}
                </Select>
            )}
        </Field>
    );
}
