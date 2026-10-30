import { INTEGRATION_KINDS, INTEGRATION_STATUSES } from '@ptbk/engine-api';
import type { AgentId, ReadIntegration } from '@ptbk/engine-api';
import {
    Button,
    Checkbox,
    ConfirmDialog,
    createDataTableColumnHelper,
    DataTable,
    Field,
    RelativeTime,
    Select,
} from '@ptbk/ui';
import type { DataTableColumnDef, MenuEntry } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plug, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { isInvalidCursor } from '../../app/list-errors';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { hasIntegrationFilters, integrationListParams, selectedStatuses } from './integration-search';
import type { IntegrationSearch } from './integration-search';
import { IntegrationStatusBadge, integrationKindLabel, integrationStatusLabel, kindNameOf } from './integration-status';
import { integrationListQueryOptions, useIntegrations } from './integrations-queries';
import { LazyIntegrationFormDialog } from './lazy-integration-form-dialog';
import { useAgentNames } from './use-agent-names';
import { useIntegrationMutations } from './use-integration-mutations';
import type { IntegrationMutations } from './use-integration-mutations';

const NO_INTEGRATIONS: readonly ReadIntegration[] = [];
export const INTEGRATION_COLUMNS_STORAGE_KEY = 'ptbk.integrations.columns';

function AgentCell({ agentId }: { readonly agentId: AgentId | null }) {
    const agentNames = useAgentNames();
    if (agentId === null) return m.integration_all_agents();
    return (
        <Link to="/agents/$agentId" params={{ agentId }} className="break-words">
            {agentNames.get(agentId) ?? agentId}
        </Link>
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
                meta: { priority: 0 },
                cell: ({ row }) => (
                    <Link
                        to="/integrations/$integrationId"
                        params={{ integrationId: row.original.id }}
                        variant="standalone"
                        className="break-words"
                    >
                        {row.original.name}
                    </Link>
                ),
            }),
            column.accessor((integration) => kindNameOf(integration), {
                id: 'kind',
                header: m.integrations_column_kind(),
                enableSorting: false,
                meta: { priority: 3 },
                cell: ({ row }) => (
                    <span className="break-words">{integrationKindLabel(kindNameOf(row.original))}</span>
                ),
            }),
            column.accessor('agentId', {
                header: m.integrations_column_agent(),
                enableSorting: false,
                meta: { priority: 2 },
                cell: ({ row }) => <AgentCell agentId={row.original.agentId} />,
            }),
            column.accessor('status', {
                header: m.integrations_column_status(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 1 },
                cell: ({ row }) => <IntegrationStatusBadge status={row.original.status} />,
            }),
            column.accessor((integration) => integration.scopes.join(', '), {
                id: 'scopes',
                header: m.integrations_column_scopes(),
                enableSorting: false,
                meta: { priority: 5 },
                cell: ({ row }) => {
                    const scopes = row.original.scopes.join(', ');
                    return scopes === '' ? (
                        <span className="text-text-muted">—</span>
                    ) : (
                        <span title={scopes} className="line-clamp-2 max-w-64 break-words">
                            {scopes}
                        </span>
                    );
                },
            }),
            column.accessor('lastActivityAt', {
                header: m.integrations_column_last_activity(),
                enableSorting: false,
                meta: { priority: 4 },
                cell: ({ row }) =>
                    row.original.lastActivityAt === null ? (
                        <span className="text-text-muted">{m.integration_never()}</span>
                    ) : (
                        <RelativeTime value={new Date(row.original.lastActivityAt)} className="whitespace-nowrap" />
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
    const agentNames = useAgentNames();
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
        <div className="flex flex-col gap-4">
            <IntegrationFilters
                search={search}
                scope={scope}
                agentNames={agentNames}
                onChange={filter}
                onClear={clear}
                filtered={filtered}
            />
            <DataTable
                caption={m.integrations_title()}
                columns={columns}
                data={list.data?.items ?? NO_INTEGRATIONS}
                getRowId={(integration) => integration.id}
                getRowLabel={(integration) => integration.name}
                visibilityStorage={{ storage, key: INTEGRATION_COLUMNS_STORAGE_KEY }}
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
        </div>
    );
}

interface IntegrationFiltersProps {
    readonly search: IntegrationSearch;
    readonly scope: 'global' | 'agent';
    readonly agentNames: ReadonlyMap<AgentId, string>;
    readonly onChange: (change: Partial<IntegrationSearch>) => void;
    readonly onClear: () => void;
    readonly filtered: boolean;
}

/** Every control reads from and writes to the search params, so a reload or a shared link restores the view. */
function IntegrationFilters({ search, scope, agentNames, onChange, onClear, filtered }: IntegrationFiltersProps) {
    const statuses = selectedStatuses(search);
    const toggleStatus = (status: (typeof INTEGRATION_STATUSES)[number], on: boolean) => {
        const next = INTEGRATION_STATUSES.filter((candidate) => (candidate === status ? on : statuses.has(candidate)));
        onChange({ status: next.length === 0 ? undefined : next.join(',') });
    };
    const knownKind = search.kind === undefined || (INTEGRATION_KINDS as readonly string[]).includes(search.kind);
    const knownAgent = search.agentId === undefined || agentNames.has(search.agentId);
    return (
        <div role="search" aria-label={m.integrations_filters()} className="flex flex-col gap-3">
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
                <legend className="mb-1 text-sm font-medium">{m.integrations_filter_status()}</legend>
                {INTEGRATION_STATUSES.map((status) => (
                    <Checkbox
                        key={status}
                        label={integrationStatusLabel(status)}
                        checked={statuses.has(status)}
                        onChange={(event) => {
                            toggleStatus(status, event.target.checked);
                        }}
                    />
                ))}
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label={m.integrations_filter_kind()}>
                    {(control) => (
                        <Select
                            {...control}
                            value={search.kind ?? ''}
                            onChange={(event) => {
                                onChange({ kind: event.target.value === '' ? undefined : event.target.value });
                            }}
                        >
                            <option value="">{m.integrations_filter_all_kinds()}</option>
                            {knownKind ? null : <option value={search.kind}>{search.kind}</option>}
                            {INTEGRATION_KINDS.map((kind) => (
                                <option key={kind} value={kind}>
                                    {integrationKindLabel(kind)}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
                {scope === 'global' ? (
                    <Field label={m.integrations_filter_agent()}>
                        {(control) => (
                            <Select
                                {...control}
                                value={search.agentId ?? ''}
                                onChange={(event) => {
                                    const agentId = [...agentNames.keys()].find((id) => id === event.target.value);
                                    onChange({ agentId });
                                }}
                            >
                                <option value="">{m.integrations_filter_all_agents()}</option>
                                {knownAgent ? null : <option value={search.agentId}>{search.agentId}</option>}
                                {[...agentNames].map(([id, name]) => (
                                    <option key={id} value={id}>
                                        {name}
                                    </option>
                                ))}
                            </Select>
                        )}
                    </Field>
                ) : null}
            </div>
            {filtered ? (
                <div>
                    <Button variant="ghost" size="sm" onClick={onClear}>
                        {m.integrations_clear_filters()}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
