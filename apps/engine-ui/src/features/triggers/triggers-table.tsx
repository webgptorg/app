import { AgentId, TRIGGER_KINDS, TRIGGER_LIFECYCLES } from '@ptbk/engine-api';
import type { ReadAgent, ReadTrigger } from '@ptbk/engine-api';
import {
    Button,
    createDataTableColumnHelper,
    DataTable,
    FilterBar,
    filterField,
    StatusDot,
    viewTransitionStyle,
} from '@ptbk/ui';
import type { DataTableColumnDef, FilterBarField, MenuEntry } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Bot, CalendarClock, CircleDot, History, Pause, Pencil, Play, Shapes, Trash2, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { isInvalidCursor } from '../../app/list-errors';
import { readOneParam } from '../../app/search-filters';
import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { EntityChip } from '../entities/entity-chip';
import { usePermissions } from '../session/use-permissions';
import { DeleteTriggerDialog } from './delete-trigger-dialog';
import { useTriggerAgents } from './trigger-agents';
import {
    knownKindLabel,
    lifecycleLabel,
    lifecycleTone,
    triggerKindLabel,
    TriggerLifecyclePill,
} from './trigger-labels';
import { hasTriggerFilters, triggerListParams } from './trigger-search';
import type { TriggerSearch } from './trigger-search';
import { triggerZone, useTriggerSummary } from './trigger-summary';
import { RelativeFireTime } from './trigger-time';
import { triggerListQueryOptions, useTriggers } from './triggers-queries';
import { canEdit, canPause, canResume, useTriggerMutations } from './use-trigger-mutations';

const NO_TRIGGERS: readonly ReadTrigger[] = [];
export const TRIGGER_COLUMNS_STORAGE_KEY = 'ptbk.triggers.columns';

const ICON = 'size-3.5';

/** The name as the row's title and what starts it under it; members type both, so both render as text. */
function TriggerTitle({ trigger, fromAgent }: { readonly trigger: ReadTrigger; readonly fromAgent: boolean }) {
    const summary = useTriggerSummary()(trigger);
    return (
        <span className="flex min-w-0 flex-col items-start gap-0.5">
            <Link
                to="/triggers/$triggerId"
                params={{ triggerId: trigger.id }}
                search={fromAgent ? { from: 'agent' } : {}}
                title={trigger.name}
                className="line-clamp-2 rounded-small font-medium break-words text-text"
            >
                <span style={viewTransitionStyle('trigger-title', trigger.id)}>{trigger.name}</span>
            </Link>
            {/* An inbound address is one long token: it may wrap after its @ and dots, never mid-name. */}
            <span className="line-clamp-1 text-xs break-words text-text-muted">
                <SoftBreaks text={summary} after="@." />
            </span>
        </span>
    );
}

function TriggerAgent({ trigger }: { readonly trigger: ReadTrigger }) {
    const profile = useTriggerAgents(true).byId.get(trigger.agentId)?.profile;
    return (
        <EntityChip
            kind="agent"
            id={trigger.agentId}
            name={trigger.agentName ?? trigger.agentId}
            {...(profile === undefined ? {} : { profile })}
        />
    );
}

function useTriggerColumns(acrossAgents: boolean, fromAgent: boolean): DataTableColumnDef<ReadTrigger>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<ReadTrigger>();
        const columns: DataTableColumnDef<ReadTrigger>[] = [
            column.accessor('name', {
                header: m.triggers_column_name(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0, icon: <Zap className={ICON} /> },
                cell: ({ row }) => <TriggerTitle trigger={row.original} fromAgent={fromAgent} />,
            }),
            column.accessor('lifecycle', {
                header: m.triggers_column_lifecycle(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 1, trailing: true, icon: <CircleDot className={ICON} /> },
                cell: ({ row }) => <TriggerLifecyclePill trigger={row.original} />,
            }),
        ];
        if (acrossAgents) {
            columns.push(
                column.accessor((trigger) => trigger.agentName ?? trigger.agentId, {
                    id: 'agent',
                    header: m.triggers_column_agent(),
                    enableSorting: false,
                    meta: { priority: 2, icon: <Bot className={ICON} /> },
                    cell: ({ row }) => <TriggerAgent trigger={row.original} />,
                }),
            );
        }
        columns.push(
            column.accessor((trigger) => triggerKindLabel(trigger), {
                id: 'kind',
                header: m.triggers_column_kind(),
                enableSorting: false,
                // On a card the line under the name already says what starts it.
                meta: { priority: 5, hideOnCard: true, icon: <Shapes className={ICON} /> },
                cell: ({ row }) => <span className="text-text-muted">{triggerKindLabel(row.original)}</span>,
            }),
            column.accessor('nextFireAt', {
                header: m.triggers_column_next(),
                enableSorting: false,
                meta: { priority: 3, numeric: true, icon: <CalendarClock className={ICON} /> },
                cell: ({ row }) => (
                    <span className="text-text-muted tabular-nums">
                        <RelativeFireTime
                            at={row.original.nextFireAt}
                            zone={triggerZone(row.original)}
                            empty={m.trigger_value_none()}
                        />
                    </span>
                ),
            }),
            column.accessor('lastFiredAt', {
                header: m.triggers_column_last(),
                enableSorting: false,
                // A card keeps only the next run: two bare relative times side by side would not say which is which.
                meta: { priority: 4, numeric: true, hideOnCard: true, icon: <History className={ICON} /> },
                cell: ({ row }) => (
                    <span className="text-text-muted tabular-nums">
                        <RelativeFireTime
                            at={row.original.lastFiredAt}
                            zone={triggerZone(row.original)}
                            empty={m.trigger_never_fired()}
                        />
                    </span>
                ),
            }),
        );
        return columns;
    }, [acrossAgents, fromAgent]);
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
    const agents = useTriggerAgents(scope === 'global');
    const columns = useTriggerColumns(scope === 'global', scope === 'agent');
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
    // Pause and resume come first: they are the owner's way to stop anything at once.
    const rowActions = (trigger: ReadTrigger): readonly MenuEntry[] => {
        if (!manage) return [];
        const target = { id: trigger.id, name: trigger.name };
        const entries: MenuEntry[] = [];
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
    const fields = triggerFilterFields({
        search,
        acrossAgents: scope === 'global' && agents.allowed,
        agents: agents.list,
        onChange: filter,
    });

    return (
        <>
            <DataTable
                caption={m.triggers_title()}
                columns={columns}
                data={list.data?.items ?? NO_TRIGGERS}
                getRowId={(trigger) => trigger.id}
                getRowLabel={(trigger) => trigger.name}
                visibilityStorage={{ storage, key: TRIGGER_COLUMNS_STORAGE_KEY }}
                toolbar={(view) => <FilterBar {...view} label={m.triggers_filters()} fields={fields} onClear={clear} />}
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
        </>
    );
}

interface TriggerFilterInput {
    readonly search: TriggerSearch;
    /** The agent field: on the global list, for a member who may see agents. */
    readonly acrossAgents: boolean;
    readonly agents: readonly ReadAgent[];
    readonly onChange: (change: Partial<TriggerSearch>) => void;
}

/**
 * Every field reads from and writes to the search params, so a reload or a shared link restores the view. The engine
 * filters by one state, agent and kind at a time and has no text search for triggers, so neither does the bar.
 */
function triggerFilterFields({
    search,
    acrossAgents,
    agents,
    onChange,
}: TriggerFilterInput): readonly FilterBarField[] {
    return [
        filterField.enum({
            id: 'lifecycle',
            label: m.triggers_filter_lifecycle(),
            icon: <CircleDot className={ICON} />,
            options: TRIGGER_LIFECYCLES.map((lifecycle) => ({
                value: lifecycle,
                label: lifecycleLabel(lifecycle),
                icon: <StatusDot tone={lifecycleTone(lifecycle)} />,
            })),
            value: search.lifecycle,
            onChange: (lifecycle) => {
                onChange({ lifecycle });
            },
        }),
        ...(acrossAgents
            ? [
                  filterField.entity({
                      id: 'agent',
                      label: m.triggers_filter_agent(),
                      icon: <Bot className={ICON} />,
                      multiple: false,
                      options: agents.map((agent) => ({
                          value: agent.id,
                          label: agent.name,
                          icon: (
                              <AgentAvatar name={agent.name} agentKey={agent.id} profile={agent.profile} size="2xs" />
                          ),
                      })),
                      value: readOneParam(search.agentId),
                      onChange: (value) => {
                          // An agent beyond the first page stays selected by its ID from the URL until it is removed.
                          const picked = value.at(-1);
                          onChange({ agentId: picked === undefined ? undefined : AgentId.safeParse(picked).data });
                      },
                  }),
              ]
            : []),
        filterField.enum({
            id: 'kind',
            label: m.triggers_filter_kind(),
            icon: <Shapes className={ICON} />,
            options: TRIGGER_KINDS.map((kind) => ({ value: kind, label: knownKindLabel(kind) })),
            value: search.kind,
            onChange: (kind) => {
                onChange({ kind });
            },
        }),
    ];
}
