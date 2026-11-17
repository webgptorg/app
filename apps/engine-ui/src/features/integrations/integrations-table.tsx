import { AgentId, INTEGRATION_KINDS, INTEGRATION_STATUSES } from '@ptbk/engine-api';
import type { ReadAgent, ReadIntegration } from '@ptbk/engine-api';
import {
    BrandRobot,
    Button,
    ConfirmDialog,
    createDataTableColumnHelper,
    DataTable,
    FilterBar,
    filterField,
    RelativeTime,
    StatusDot,
} from '@ptbk/ui';
import type { DataTableColumnDef, DataTableView, FilterBarField, FilterBarOption, MenuEntry } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import {
    Bot,
    CalendarClock,
    CircleDot,
    Hash,
    KeyRound,
    Pencil,
    Plug,
    PlugZap,
    RefreshCw,
    Shapes,
    Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { readListParam, readOneParam, writeListParam } from '../../app/search-filters';
import { isInvalidCursor } from '../../app/list-errors';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { EntityChip } from '../entities/entity-chip';
import { usePermissions } from '../session/use-permissions';
import { hasIntegrationFilters, integrationListParams } from './integration-search';
import type { IntegrationSearch } from './integration-search';
import {
    IntegrationStatusBadge,
    integrationKindIcon,
    integrationKindLabel,
    integrationStatusLabel,
    integrationStatusTone,
    kindNameOf,
    ScopePill,
} from './integration-status';
import { integrationListQueryOptions, useIntegrations } from './integrations-queries';
import { LazyIntegrationFormDialog } from './lazy-integration-form-dialog';
import { useAgents } from './use-agent-names';
import { useIntegrationMutations } from './use-integration-mutations';
import type { IntegrationMutations } from './use-integration-mutations';

const NO_INTEGRATIONS: readonly ReadIntegration[] = [];
export const INTEGRATION_COLUMNS_STORAGE_KEY = 'ptbk.integrations.columns';
const ICON = 'size-3.5';
/** Scopes a row shows before "+N"; the detail page lists them all. */
const ROW_SCOPES = 2;

function AgentCell({ agentId }: { readonly agentId: AgentId | null }) {
    const agents = useAgents();
    const agent = agentId === null ? undefined : agents.get(agentId);
    if (agentId === null) return <span className="text-sm text-text-muted">{m.integration_all_agents()}</span>;
    return (
        <EntityChip
            kind="agent"
            id={agentId}
            name={agent?.name ?? agentId}
            {...(agent === undefined ? {} : { profile: agent.profile })}
        />
    );
}

function ScopesCell({ scopes }: { readonly scopes: readonly string[] }) {
    if (scopes.length === 0) return null;
    const rest = scopes.length - ROW_SCOPES;
    return (
        <span title={scopes.join(', ')} className="flex min-w-0 flex-wrap items-center gap-1">
            {scopes.slice(0, ROW_SCOPES).map((scope) => (
                <ScopePill key={scope} scope={scope} />
            ))}
            {rest > 0 ? (
                <span className="text-xs text-text-muted tabular-nums">
                    {m.integrations_scopes_more({ count: rest })}
                </span>
            ) : null}
        </span>
    );
}

function useIntegrationColumns(): DataTableColumnDef<ReadIntegration>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<ReadIntegration>();
        return [
            // Names come from members, tool and kind names partly from third parties: React renders them as text.
            column.accessor('name', {
                header: m.integrations_column_name(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0, grow: true, icon: <Hash className={ICON} /> },
                cell: ({ row }) => (
                    <span className="flex min-w-0 items-start gap-2.5">
                        <span aria-hidden="true" className="mt-0.5 flex shrink-0 text-text-muted [&>svg]:size-4">
                            {integrationKindIcon(kindNameOf(row.original))}
                        </span>
                        <Link
                            to="/integrations/$integrationId"
                            params={{ integrationId: row.original.id }}
                            variant="standalone"
                            className="line-clamp-2 min-w-0 font-medium break-words text-text"
                        >
                            {row.original.name}
                        </Link>
                    </span>
                ),
            }),
            column.accessor('status', {
                header: m.integrations_column_status(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 1, icon: <CircleDot className={ICON} /> },
                cell: ({ row }) => <IntegrationStatusBadge status={row.original.status} />,
            }),
            column.accessor((integration) => kindNameOf(integration), {
                id: 'kind',
                header: m.integrations_column_kind(),
                enableSorting: false,
                meta: { priority: 3, icon: <Shapes className={ICON} /> },
                cell: ({ row }) => (
                    <span className="break-words text-text-muted">
                        {integrationKindLabel(kindNameOf(row.original))}
                    </span>
                ),
            }),
            column.accessor('agentId', {
                header: m.integrations_column_agent(),
                enableSorting: false,
                meta: { priority: 2, icon: <Bot className={ICON} /> },
                cell: ({ row }) => <AgentCell agentId={row.original.agentId} />,
            }),
            column.accessor((integration) => integration.scopes.join(', '), {
                id: 'scopes',
                header: m.integrations_column_scopes(),
                enableSorting: false,
                meta: { priority: 5, icon: <KeyRound className={ICON} /> },
                cell: ({ row }) => <ScopesCell scopes={row.original.scopes} />,
            }),
            column.accessor('lastActivityAt', {
                header: m.integrations_column_last_activity(),
                enableSorting: false,
                meta: { priority: 4, trailing: true, numeric: true, icon: <CalendarClock className={ICON} /> },
                cell: ({ row }) =>
                    row.original.lastActivityAt === null ? (
                        <span className="whitespace-nowrap text-text-muted">{m.integration_never()}</span>
                    ) : (
                        <RelativeTime
                            value={new Date(row.original.lastActivityAt)}
                            className="whitespace-nowrap text-text-muted"
                        />
                    ),
            }),
        ];
    }, []);
}

type PendingRowAction = { readonly kind: 'edit' | 'delete'; readonly integration: ReadIntegration } | null;

/**
 * The same set as the detail page, in its order: edit, enable or disable, check, and delete last and set apart. Empty
 * without `integrations.manage`, so no menu renders.
 */
function useIntegrationRowActions(
    mutations: IntegrationMutations,
    onPending: (pending: PendingRowAction) => void,
): (integration: ReadIntegration) => readonly MenuEntry[] {
    const { can } = usePermissions();
    const { enable, disable, check } = mutations;
    return (integration) => {
        if (!can('integrations.manage')) return [];
        const target = { id: integration.id, name: integration.name };
        return [
            {
                kind: 'item',
                id: 'edit',
                label: m.integration_edit(),
                icon: <Pencil aria-hidden />,
                onSelect: () => {
                    onPending({ kind: 'edit', integration });
                },
            },
            integration.status === 'disconnected'
                ? {
                      kind: 'item',
                      id: 'enable',
                      label: m.integration_enable(),
                      icon: <PlugZap aria-hidden />,
                      onSelect: () => {
                          enable.mutate(target);
                      },
                  }
                : {
                      kind: 'item',
                      id: 'disable',
                      label: m.integration_disable(),
                      icon: <Plug aria-hidden />,
                      onSelect: () => {
                          disable.mutate(target);
                      },
                  },
            {
                kind: 'item',
                id: 'check',
                label: m.integration_check(),
                icon: <RefreshCw aria-hidden />,
                onSelect: () => {
                    check.mutate(target);
                },
            },
            { kind: 'separator', id: 'danger' },
            {
                kind: 'item',
                id: 'delete',
                label: m.integration_delete(),
                icon: <Trash2 aria-hidden />,
                tone: 'danger',
                onSelect: () => {
                    onPending({ kind: 'delete', integration });
                },
            },
        ];
    };
}

export interface IntegrationsTableProps {
    readonly search: IntegrationSearch;
    /** Applies a change to the URL, which is the only place the filters and page live. */
    readonly onSearchChange: (change: Partial<IntegrationSearch>, options?: { readonly replace?: boolean }) => void;
    /** On an agent's tab: what that agent may use, its own and the engine-wide integrations, without the agent filter. */
    readonly agentId?: AgentId;
}

/** Integrations, global or for one agent: every filter and page is applied by the engine, newest first. */
export function IntegrationsTable({ search, onSearchChange, agentId }: IntegrationsTableProps) {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const { storage } = useBrowser();
    const params = integrationListParams(search, agentId);
    const list = useIntegrations(params);
    const scope = agentId === undefined ? 'global' : 'agent';
    const agents = useAgents();
    const columns = useIntegrationColumns();
    const mutations = useIntegrationMutations();
    const [pending, setPending] = useState<PendingRowAction>(null);
    const rowActions = useIntegrationRowActions(mutations, setPending);
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        onSearchChange({ cursor });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) onSearchChange({ cursor: undefined }, { replace: true });
    }, [invalidCursor, onSearchChange]);

    const filtered = hasIntegrationFilters(search, scope);
    const filter = (change: Partial<IntegrationSearch>) => {
        onSearchChange({ cursor: undefined, ...change });
    };
    const clear = () => {
        filter({ kind: undefined, status: undefined, agentId: undefined });
    };

    return (
        <>
            <DataTable
                caption={m.integrations_title()}
                columns={columns}
                data={list.data?.items ?? NO_INTEGRATIONS}
                getRowId={(integration) => integration.id}
                getRowLabel={(integration) => integration.name}
                visibilityStorage={{ storage, key: INTEGRATION_COLUMNS_STORAGE_KEY }}
                toolbar={(view) => (
                    <IntegrationFilters
                        view={view}
                        search={search}
                        scope={scope}
                        agents={agents}
                        onChange={filter}
                        onClear={clear}
                    />
                )}
                rowActions={rowActions}
                page={paging.page}
                onPageChange={paging.onPageChange}
                onPageIntent={(cursor, direction) => {
                    if (direction !== 'next') return;
                    queryClient
                        .query(integrationListQueryOptions(engineApi, { ...params, cursor }))
                        .catch(() => undefined);
                }}
                loading={list.isPending}
                fetching={list.isFetching && !list.isPending}
                {...(list.isError && !invalidCursor
                    ? {
                          error: {
                              message: m.integrations_load_failed(),
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
                              title: m.integrations_no_results(),
                              description: m.integrations_no_results_hint(),
                              action: <Button onClick={clear}>{m.integrations_clear_filters()}</Button>,
                          }
                        : {
                              icon: <Plug />,
                              ...(scope === 'agent' ? {} : { illustration: <BrandRobot pose="assembling" /> }),
                              title: m.integrations_empty_title(),
                              description:
                                  scope === 'agent' ? m.integrations_empty_agent_body() : m.integrations_empty_body(),
                          }
                }
            />
            {pending?.kind === 'edit' ? (
                <LazyIntegrationFormDialog
                    mode={{ kind: 'edit', integration: pending.integration }}
                    mutations={mutations}
                    onClose={() => {
                        setPending(null);
                    }}
                />
            ) : null}
            <ConfirmDialog
                open={pending?.kind === 'delete'}
                onClose={() => {
                    setPending(null);
                }}
                onConfirm={async () => {
                    if (pending === null) return;
                    try {
                        await mutations.remove.mutateAsync({
                            id: pending.integration.id,
                            name: pending.integration.name,
                        });
                        setPending(null);
                    } catch {
                        // Reported in a toast; the dialog stays open for another try.
                    }
                }}
                title={m.integration_delete_title({ name: pending?.integration.name ?? '' })}
                description={m.integration_delete_body()}
                confirmLabel={m.integration_delete()}
                tone="danger"
                loading={mutations.remove.isPending}
            />
        </>
    );
}

interface IntegrationFiltersProps {
    readonly view: DataTableView;
    readonly search: IntegrationSearch;
    readonly scope: 'global' | 'agent';
    readonly agents: ReadonlyMap<AgentId, ReadAgent>;
    readonly onChange: (change: Partial<IntegrationSearch>) => void;
    readonly onClear: () => void;
}

/** Every filter reads from and writes to the search params, so a reload or a shared link restores the view. */
function IntegrationFilters({ view, search, scope, agents, onChange, onClear }: IntegrationFiltersProps) {
    const agentsVisible = useAllows({ permission: 'agents.read' });
    const kind = search.kind;
    // A kind a newer engine added stays selectable from a link, by the name it sent.
    const kindOptions: FilterBarOption[] = [
        ...(kind === undefined || INTEGRATION_KINDS.some((known) => known === kind) ? [] : [kind]),
        ...INTEGRATION_KINDS,
    ].map((value) => ({
        value,
        label: integrationKindLabel(value),
        icon: <span className="flex [&>svg]:size-3.5">{integrationKindIcon(value)}</span>,
    }));
    const fields: FilterBarField[] = [
        filterField.multiEnum({
            id: 'status',
            label: m.integrations_filter_status(),
            icon: <CircleDot className={ICON} />,
            options: INTEGRATION_STATUSES.map((status) => ({
                value: status,
                label: integrationStatusLabel(status),
                icon: <StatusDot tone={integrationStatusTone(status)} />,
            })),
            value: readListParam(search.status, INTEGRATION_STATUSES),
            onChange: (value) => {
                onChange({ status: writeListParam(value, INTEGRATION_STATUSES) });
            },
        }),
        filterField.enum({
            id: 'kind',
            label: m.integrations_filter_kind(),
            icon: <Shapes className={ICON} />,
            options: kindOptions,
            value: kind,
            onChange: (value) => {
                onChange({ kind: value });
            },
        }),
        ...(scope === 'global' && agentsVisible
            ? [
                  filterField.entity<string>({
                      id: 'agent',
                      label: m.integrations_filter_agent(),
                      icon: <Bot className={ICON} />,
                      multiple: false,
                      options: [...agents.values()].map((agent) => ({
                          value: agent.id,
                          label: agent.name,
                          icon: (
                              <AgentAvatar
                                  name={agent.name}
                                  agentKey={agent.id}
                                  profile={agent.profile}
                                  origin={agent.origin}
                                  size="2xs"
                              />
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
    ];
    return <FilterBar {...view} label={m.integrations_filters()} fields={fields} onClear={onClear} />;
}
