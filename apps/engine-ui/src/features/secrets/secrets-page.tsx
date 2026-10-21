import { SECRET_STATUSES } from '@ptbk/engine-api';
import type { AgentId, SecretMetadata, SecretScope } from '@ptbk/engine-api';
import {
    Badge,
    Button,
    CodeText,
    ConfirmDialog,
    createDataTableColumnHelper,
    DataTable,
    Field,
    Input,
    RelativeTime,
} from '@ptbk/ui';
import type { ColumnFiltersState, DataTableColumnDef, MenuEntry, SortingState } from '@ptbk/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Ban, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useDebouncedSearch } from '../../app/debounced-search';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { isInvalidCursor, isPageLevelFailure } from '../../app/list-errors';
import { m } from '../../paraglide/messages';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { DEFAULT_SECRET_SORT, SECRET_SCOPE_KINDS, secretListParams } from './secret-list-search';
import type { SecretListSearch } from './secret-list-search';
import { secretListQueryOptions } from './secrets-queries';
import { useSecretMutations } from './use-secret-mutations';
import type { SecretTarget } from './use-secret-mutations';

const route = getRouteApi('/secrets');

// The dialogs bring the form layer, so they load when first opened rather than with the table.
const CreateSecretDialog = lazy(() =>
    import('./create-secret-dialog').then((module) => ({ default: module.CreateSecretDialog })),
);
const ReplaceSecretDialog = lazy(() =>
    import('./replace-secret-dialog').then((module) => ({ default: module.ReplaceSecretDialog })),
);

export const SECRET_COLUMNS_STORAGE_KEY = 'ptbk.secrets.columns';
const NO_SECRETS: readonly SecretMetadata[] = [];

type SortField = 'name' | 'createdAt' | 'lastUsedAt';
const SORTABLE: ReadonlySet<string> = new Set<SortField>(['name', 'createdAt', 'lastUsedAt']);

function sortingOf(sort: SecretListSearch['sort']): SortingState {
    const desc = sort.startsWith('-');
    const id = desc ? sort.slice(1) : sort;
    return SORTABLE.has(id) ? [{ id, desc }] : [];
}

function sortOf(sorting: SortingState): SecretListSearch['sort'] {
    const [first] = sorting;
    if (first === undefined || !SORTABLE.has(first.id)) return DEFAULT_SECRET_SORT;
    const field = first.id as SortField;
    return first.desc ? `-${field}` : field;
}

function filtersOf(search: SecretListSearch): ColumnFiltersState {
    return [
        ...(search.scope === undefined ? [] : [{ id: 'scope', value: search.scope }]),
        ...(search.status === undefined ? [] : [{ id: 'status', value: search.status }]),
    ];
}

function filterValue<T extends string>(filters: ColumnFiltersState, id: string, known: readonly T[]): T | undefined {
    const value = filters.find((filter) => filter.id === id)?.value;
    return known.find((candidate) => candidate === value);
}

function AgentScope({ agentId }: { readonly agentId: AgentId }) {
    const { can } = usePermissions();
    const agent = useQuery({ ...agentDetailQueryOptions(useEngineApi(), agentId), enabled: can('agents.read') });
    if (agent.data === undefined) return <CodeText value={agentId} />;
    return (
        <Link to="/agents/$agentId" params={{ agentId }}>
            {agent.data.name}
        </Link>
    );
}

function ScopeCell({ scope }: { readonly scope: SecretScope }) {
    if (scope.kind === 'engine') return <span>{m.secrets_scope_engine()}</span>;
    return (
        <span className="inline-flex flex-wrap items-center gap-1">
            {m.secrets_scope_agent_prefix()} <AgentScope agentId={scope.agentId} />
        </span>
    );
}

function Timestamp({ value }: { readonly value: string | null }) {
    return value === null ? (
        <span className="text-text-muted">{m.secrets_never()}</span>
    ) : (
        <RelativeTime value={new Date(value)} />
    );
}

function useSecretColumns(): DataTableColumnDef<SecretMetadata>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<SecretMetadata>();
        return [
            column.accessor('name', {
                header: m.secrets_column_name(),
                enableHiding: false,
                meta: { priority: 0 },
                cell: ({ row }) => <CodeText value={row.original.name} />,
            }),
            column.accessor((secret) => secret.scope.kind, {
                id: 'scope',
                header: m.secrets_column_scope(),
                enableSorting: false,
                meta: {
                    priority: 2,
                    filter: {
                        kind: 'select',
                        allLabel: m.secrets_filter_all_scopes(),
                        options: [
                            { value: 'engine', label: m.secrets_scope_engine() },
                            { value: 'agent', label: m.secrets_scope_agent() },
                        ],
                    },
                },
                cell: ({ row }) => <ScopeCell scope={row.original.scope} />,
            }),
            column.accessor('status', {
                header: m.secrets_column_state(),
                enableSorting: false,
                meta: {
                    priority: 1,
                    filter: {
                        kind: 'select',
                        allLabel: m.secrets_filter_all_states(),
                        options: [
                            { value: 'active', label: m.secrets_state_active() },
                            { value: 'revoked', label: m.secrets_state_revoked() },
                        ],
                    },
                },
                cell: ({ row }) =>
                    row.original.status === 'active' ? (
                        <Badge tone="success">{m.secrets_state_active()}</Badge>
                    ) : (
                        <Badge tone="neutral">{m.secrets_state_revoked()}</Badge>
                    ),
            }),
            column.accessor('createdAt', {
                header: m.secrets_column_created(),
                sortDescFirst: true,
                meta: { priority: 5 },
                cell: ({ row }) => <Timestamp value={row.original.createdAt} />,
            }),
            column.accessor('valueUpdatedAt', {
                header: m.secrets_column_rotated(),
                enableSorting: false,
                meta: { priority: 4 },
                cell: ({ row }) => <Timestamp value={row.original.valueUpdatedAt} />,
            }),
            column.accessor('lastUsedAt', {
                header: m.secrets_column_last_used(),
                sortDescFirst: true,
                meta: { priority: 3 },
                cell: ({ row }) => <Timestamp value={row.original.lastUsedAt} />,
            }),
        ];
    }, []);
}

type Pending =
    | { readonly kind: 'create' }
    | { readonly kind: 'replace'; readonly secret: SecretTarget }
    | { readonly kind: 'revoke'; readonly secret: SecretTarget }
    | { readonly kind: 'delete'; readonly secret: SecretTarget };

/** Secret metadata only: no response carries a value, and the UI has no way to show one. */
export function SecretsPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const { storage } = useBrowser();
    const { can } = usePermissions();
    const canManage = can('secrets.manage');
    const mutations = useSecretMutations();
    const columns = useSecretColumns();
    const [pending, setPending] = useState<Pending | null>(null);
    const close = () => {
        setPending(null);
    };
    const list = useQuery({
        ...secretListQueryOptions(useEngineApi(), secretListParams(search)),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevelFailure,
    });

    const update = (change: Partial<SecretListSearch>, replace = false) => {
        void navigate({ search: (previous) => ({ ...previous, cursor: undefined, ...change }), replace });
    };
    const [text, setText] = useDebouncedSearch(search.q, (q) => {
        update({ q }, true);
    });
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        void navigate({ search: (previous) => ({ ...previous, cursor }) });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) void navigate({ search: (previous) => ({ ...previous, cursor: undefined }), replace: true });
    }, [invalidCursor, navigate]);

    const target = (secret: SecretMetadata): SecretTarget => ({ id: secret.id, name: secret.name });
    const rowActions = (secret: SecretMetadata): MenuEntry[] => {
        if (!canManage) return [];
        const entries: MenuEntry[] = [];
        if (secret.status === 'active') {
            entries.push(
                {
                    kind: 'item',
                    id: 'replace',
                    label: m.secrets_action_replace(),
                    icon: <RefreshCw />,
                    onSelect: () => {
                        setPending({ kind: 'replace', secret: target(secret) });
                    },
                },
                {
                    kind: 'item',
                    id: 'revoke',
                    label: m.secrets_action_revoke(),
                    icon: <Ban />,
                    onSelect: () => {
                        setPending({ kind: 'revoke', secret: target(secret) });
                    },
                },
                { kind: 'separator', id: 'danger' },
            );
        }
        entries.push({
            kind: 'item',
            id: 'delete',
            label: m.secrets_action_delete(),
            icon: <Trash2 />,
            tone: 'danger',
            onSelect: () => {
                setPending({ kind: 'delete', secret: target(secret) });
            },
        });
        return entries;
    };

    const newSecret = canManage ? (
        <Button
            variant="primary"
            onClick={() => {
                setPending({ kind: 'create' });
            }}
        >
            <Plus aria-hidden className="size-4" />
            {m.secrets_new()}
        </Button>
    ) : null;
    const filtered = search.q !== undefined || search.scope !== undefined || search.status !== undefined;

    return (
        <Page title={m.secrets_title()} actions={newSecret}>
            <p className="text-sm text-text-muted">{m.secrets_write_only()}</p>
            <Field label={m.secrets_search_label()} className="w-full sm:max-w-sm">
                {(control) => (
                    <Input
                        {...control}
                        type="search"
                        value={text}
                        autoComplete="off"
                        maxLength={128}
                        onChange={(event) => {
                            setText(event.target.value);
                        }}
                    />
                )}
            </Field>
            <DataTable
                caption={m.secrets_title()}
                columns={columns}
                data={list.data?.items ?? NO_SECRETS}
                getRowId={(secret) => secret.id}
                getRowLabel={(secret) => secret.name}
                sorting={sortingOf(search.sort)}
                onSortingChange={(sorting) => {
                    update({ sort: sortOf(sorting) });
                }}
                columnFilters={filtersOf(search)}
                onColumnFiltersChange={(filters) => {
                    update({
                        scope: filterValue(filters, 'scope', SECRET_SCOPE_KINDS),
                        status: filterValue(filters, 'status', SECRET_STATUSES),
                    });
                }}
                visibilityStorage={{ storage, key: SECRET_COLUMNS_STORAGE_KEY }}
                page={paging.page}
                onPageChange={paging.onPageChange}
                loading={list.isPending}
                fetching={list.isFetching && !list.isPending}
                {...(list.isError && !invalidCursor
                    ? {
                          error: {
                              message: m.secrets_load_failed(),
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
                              title: m.secrets_no_results(),
                              description: m.secrets_no_results_hint(),
                              action: (
                                  <Button
                                      onClick={() => {
                                          setText('');
                                          update({ q: undefined, scope: undefined, status: undefined });
                                      }}
                                  >
                                      {m.secrets_clear_filters()}
                                  </Button>
                              ),
                          }
                        : {
                              title: m.secrets_empty_title(),
                              description: m.secrets_empty_body(),
                              ...(newSecret === null ? {} : { action: newSecret }),
                          }
                }
                {...(canManage ? { rowActions } : {})}
            />
            {pending?.kind === 'create' ? (
                <Suspense fallback={null}>
                    <CreateSecretDialog onClose={close} mutations={mutations} />
                </Suspense>
            ) : null}
            {pending?.kind === 'replace' ? (
                <Suspense fallback={null}>
                    <ReplaceSecretDialog secret={pending.secret} onClose={close} mutations={mutations} />
                </Suspense>
            ) : null}
            {pending?.kind === 'revoke' ? (
                <ConfirmDialog
                    open
                    onClose={close}
                    title={m.secrets_revoke_title({ name: pending.secret.name })}
                    description={m.secrets_revoke_body()}
                    confirmLabel={m.secrets_action_revoke()}
                    tone="danger"
                    loading={mutations.revoke.isPending}
                    onConfirm={() => {
                        mutations.revoke.mutate(pending.secret, { onSuccess: close });
                    }}
                />
            ) : null}
            {pending?.kind === 'delete' ? (
                <ConfirmDialog
                    open
                    onClose={close}
                    title={m.secrets_delete_title({ name: pending.secret.name })}
                    description={m.secrets_delete_body()}
                    confirmLabel={m.secrets_action_delete()}
                    confirmPhrase={pending.secret.name}
                    tone="danger"
                    loading={mutations.remove.isPending}
                    onConfirm={() => {
                        mutations.remove.mutate(pending.secret, { onSuccess: close });
                    }}
                />
            ) : null}
        </Page>
    );
}
