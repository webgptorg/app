import { TRIGGER_KINDS, TRIGGER_LIFECYCLES } from '@ptbk/engine-api';
import type { AgentId, ReadTrigger } from '@ptbk/engine-api';
import { Button, createDataTableColumnHelper, DataTable, Field, Select, VisuallyHidden } from '@ptbk/ui';
import type { DataTableColumnDef, MenuEntry } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { isInvalidCursor } from '../../app/list-errors';
import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { agentListQueryOptions } from '../agents/agents-queries';
import { usePermissions } from '../session/use-permissions';
import { DeleteTriggerDialog } from './delete-trigger-dialog';
import { knownKindLabel, lifecycleLabel, triggerKindLabel, TriggerLifecycleBadge } from './trigger-labels';
import { hasTriggerFilters, triggerListParams } from './trigger-search';
import type { TriggerSearch } from './trigger-search';
import { triggerZone, useTriggerSummary } from './trigger-summary';
import { RelativeFireTime } from './trigger-time';
import { TriggerToggle } from './trigger-toggle';
import { triggerListQueryOptions, useTriggers } from './triggers-queries';
import { canEdit, canPause, canResume, useTriggerMutations } from './use-trigger-mutations';

const NO_TRIGGERS: readonly ReadTrigger[] = [];
// The first page of agents fills the agent filter; a trigger of another agent still shows, by its own name.
const AGENT_FILTER_LIMIT = 100;
export const TRIGGER_COLUMNS_STORAGE_KEY = 'ptbk.triggers.columns';

function useTriggerColumns(showAgent: boolean, manage: boolean, fromAgent: boolean): DataTableColumnDef<ReadTrigger>[] {
    const summary = useTriggerSummary();
    return useMemo(() => {
        const column = createDataTableColumnHelper<ReadTrigger>();
        const columns: DataTableColumnDef<ReadTrigger>[] = [
            // Names are typed by members: React renders them as text.
            column.accessor('name', {
                header: m.triggers_column_name(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0 },
                // One line in the table, so the row stays one line; a long name ends in an ellipsis with the full name on
                // hover. A card has the width to wrap it.
                cell: ({ row }) => (
                    <Link
                        to="/triggers/$triggerId"
                        params={{ triggerId: row.original.id }}
                        search={fromAgent ? { from: 'agent' } : {}}
                        variant="standalone"
                        title={row.original.name}
                        className="inline-block max-w-full break-words md:max-w-72 md:truncate md:align-bottom"
                    >
                        {row.original.name}
                    </Link>
                ),
            }),
            column.accessor('lifecycle', {
                header: m.triggers_column_lifecycle(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 1 },
                cell: ({ row }) => <TriggerLifecycleBadge trigger={row.original} />,
            }),
        ];
        if (manage) {
            // A column, not only the row menu, so pause and resume are one tap on a card too.
            columns.push(
                column.display({
                    id: 'control',
                    // The buttons name themselves; a visible header would only add a word to scan past.
                    header: () => <VisuallyHidden>{m.triggers_column_toggle()}</VisuallyHidden>,
                    enableHiding: false,
                    meta: { priority: 2, label: m.triggers_column_toggle() },
                    cell: ({ row }) => <TriggerToggle trigger={row.original} />,
                }),
            );
        }
        if (showAgent) {
            columns.push(
                column.accessor((trigger) => trigger.agentName ?? trigger.agentId, {
                    id: 'agent',
                    header: m.triggers_column_agent(),
                    enableSorting: false,
                    meta: { priority: 4 },
                    cell: ({ row }) => (
                        <Link to="/agents/$agentId" params={{ agentId: row.original.agentId }} className="break-words">
                            {row.original.agentName ?? row.original.agentId}
                        </Link>
                    ),
                }),
            );
        }
        columns.push(
            column.accessor((trigger) => triggerKindLabel(trigger), {
                id: 'kind',
                header: m.triggers_column_kind(),
                enableSorting: false,
                meta: { priority: 5 },
            }),
            column.accessor((trigger) => summary(trigger), {
                id: 'summary',
                header: m.triggers_column_summary(),
                enableSorting: false,
                meta: { priority: 6 },
                // An inbound address is one long token: it may wrap after its @ and dots, never mid-name.
                cell: ({ row }) => (
                    <span className="break-words">
                        <SoftBreaks text={summary(row.original)} after="@." />
                    </span>
                ),
            }),
            column.accessor('nextFireAt', {
                header: m.triggers_column_next(),
                enableSorting: false,
                meta: { priority: 3 },
                cell: ({ row }) => (
                    <RelativeFireTime
                        at={row.original.nextFireAt}
                        zone={triggerZone(row.original)}
                        empty={m.trigger_value_none()}
                    />
                ),
            }),
            column.accessor('lastFiredAt', {
                header: m.triggers_column_last(),
                enableSorting: false,
                meta: { priority: 7 },
                cell: ({ row }) => (
                    <RelativeFireTime
                        at={row.original.lastFiredAt}
                        zone={triggerZone(row.original)}
                        empty={m.trigger_never_fired()}
                    />
                ),
            }),
        );
        return columns;
    }, [showAgent, manage, fromAgent, summary]);
}

export interface TriggersTableProps {
    readonly search: TriggerSearch;
    /** Applies a change to the URL, which is the only place the filters and page live. */
    readonly onSearchChange: (change: Partial<TriggerSearch>, options?: { readonly replace?: boolean }) => void;
    /** On an agent's tab: only that agent's triggers, without the agent column and filter. */
    readonly agentId?: AgentId;
}

/** Triggers, global or for one agent: every filter and page is applied by the engine, newest first. */
export function TriggersTable({ search, onSearchChange, agentId }: TriggersTableProps) {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const { storage } = useBrowser();
    const { can } = usePermissions();
    const manage = can('triggers.manage');
    const params = triggerListParams(search, agentId);
    const list = useTriggers(params);
    const scope = agentId === undefined ? 'global' : 'agent';
    const columns = useTriggerColumns(scope === 'global', manage, scope === 'agent');
    const [deleting, setDeleting] = useState<ReadTrigger | null>(null);
    const navigate = useNavigate();
    const { pause, resume } = useTriggerMutations();
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        onSearchChange({ cursor });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) onSearchChange({ cursor: undefined }, { replace: true });
    }, [invalidCursor, onSearchChange]);

    const filtered = hasTriggerFilters(search, scope);
    const filter = (change: Partial<TriggerSearch>) => {
        onSearchChange({ cursor: undefined, ...change });
    };
    const clear = () => {
        filter({ kind: undefined, lifecycle: undefined, agentId: undefined });
    };
    const rowActions = (trigger: ReadTrigger): readonly MenuEntry[] => {
        if (!manage) return [];
        const target = { id: trigger.id, name: trigger.name };
        const entries: MenuEntry[] = [];
        if (canEdit(trigger)) {
            entries.push({
                kind: 'item',
                id: 'edit',
                label: m.trigger_edit(),
                icon: <Pencil aria-hidden />,
                onSelect: () => {
                    void navigate({
                        to: '/triggers/$triggerId/edit',
                        params: { triggerId: trigger.id },
                        search: scope === 'agent' ? { from: 'agent' } : {},
                    });
                },
            });
        }
        if (canPause(trigger)) {
            entries.push({
                kind: 'item',
                id: 'pause',
                label: m.trigger_pause(),
                icon: <Pause aria-hidden />,
                onSelect: () => {
                    pause.mutate(target);
                },
            });
        } else if (canResume(trigger)) {
            entries.push({
                kind: 'item',
                id: 'resume',
                label: m.trigger_resume(),
                icon: <Play aria-hidden />,
                onSelect: () => {
                    resume.mutate(target);
                },
            });
        }
        entries.push(
            { kind: 'separator', id: 'danger' },
            {
                kind: 'item',
                id: 'delete',
                label: m.trigger_delete(),
                icon: <Trash2 aria-hidden />,
                tone: 'danger',
                onSelect: () => {
                    setDeleting(trigger);
                },
            },
        );
        return entries;
    };

    return (
        <div className="flex flex-col gap-4">
            <TriggerFilters search={search} scope={scope} onChange={filter} onClear={clear} filtered={filtered} />
            <DataTable
                caption={m.triggers_title()}
                columns={columns}
                data={list.data?.items ?? NO_TRIGGERS}
                getRowId={(trigger) => trigger.id}
                getRowLabel={(trigger) => trigger.name}
                visibilityStorage={{ storage, key: TRIGGER_COLUMNS_STORAGE_KEY }}
                rowActions={rowActions}
                page={paging.page}
                onPageChange={paging.onPageChange}
                onPageIntent={(cursor, direction) => {
                    if (direction !== 'next') return;
                    queryClient.query(triggerListQueryOptions(engineApi, { ...params, cursor })).catch(() => undefined);
                }}
                loading={list.isPending}
                fetching={list.isFetching && !list.isPending}
                {...(list.isError && !invalidCursor
                    ? {
                          error: {
                              message: m.triggers_load_failed(),
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
                              title: m.triggers_no_results(),
                              description: m.triggers_no_results_hint(),
                              action: <Button onClick={clear}>{m.triggers_clear_filters()}</Button>,
                          }
                        : {
                              title: m.triggers_empty_title(),
                              description: scope === 'agent' ? m.triggers_empty_agent_body() : m.triggers_empty_body(),
                          }
                }
            />
            {deleting === null ? null : (
                <DeleteTriggerDialog
                    trigger={deleting}
                    onClose={() => {
                        setDeleting(null);
                    }}
                />
            )}
        </div>
    );
}

interface TriggerFiltersProps {
    readonly search: TriggerSearch;
    readonly scope: 'global' | 'agent';
    readonly onChange: (change: Partial<TriggerSearch>) => void;
    readonly onClear: () => void;
    readonly filtered: boolean;
}

function choice<T extends string>(value: string, known: readonly T[]): T | undefined {
    return known.find((candidate) => candidate === value);
}

/** Every control reads from and writes to the search params, so a reload or a shared link restores the view. */
function TriggerFilters({ search, scope, onChange, onClear, filtered }: TriggerFiltersProps) {
    return (
        <div role="search" aria-label={m.triggers_filters()} className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={m.triggers_filter_kind()}>
                    {(control) => (
                        <Select
                            {...control}
                            value={search.kind ?? ''}
                            onChange={(event) => {
                                onChange({ kind: choice(event.target.value, TRIGGER_KINDS) });
                            }}
                        >
                            <option value="">{m.triggers_filter_all_kinds()}</option>
                            {TRIGGER_KINDS.map((kind) => (
                                <option key={kind} value={kind}>
                                    {knownKindLabel(kind)}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
                <Field label={m.triggers_filter_lifecycle()}>
                    {(control) => (
                        <Select
                            {...control}
                            value={search.lifecycle ?? ''}
                            onChange={(event) => {
                                onChange({ lifecycle: choice(event.target.value, TRIGGER_LIFECYCLES) });
                            }}
                        >
                            <option value="">{m.triggers_filter_all_lifecycles()}</option>
                            {TRIGGER_LIFECYCLES.map((lifecycle) => (
                                <option key={lifecycle} value={lifecycle}>
                                    {lifecycleLabel(lifecycle)}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
                {scope === 'global' ? <AgentFilter search={search} onChange={onChange} /> : null}
            </div>
            {filtered ? (
                <div>
                    <Button variant="ghost" size="sm" onClick={onClear}>
                        {m.triggers_clear_filters()}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

function AgentFilter({ search, onChange }: Pick<TriggerFiltersProps, 'search' | 'onChange'>) {
    const agents = useQuery(agentListQueryOptions(useEngineApi(), { limit: AGENT_FILTER_LIMIT, sort: 'name' }));
    const items = agents.data?.items ?? [];
    const known = search.agentId === undefined || items.some((agent) => agent.id === search.agentId);
    return (
        <Field label={m.triggers_filter_agent()}>
            {(control) => (
                <Select
                    {...control}
                    value={search.agentId ?? ''}
                    onChange={(event) => {
                        onChange({ agentId: items.find((agent) => agent.id === event.target.value)?.id });
                    }}
                >
                    <option value="">{m.triggers_filter_all_agents()}</option>
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
