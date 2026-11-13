import { AGENT_RUN_STATES, AGENT_VISIBILITIES, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { Agent } from '@ptbk/engine-api';
import { Button, createDataTableColumnHelper, DataTable, LegacyFilterBar, RelativeTime } from '@ptbk/ui';
import type { DataTableColumnDef, SortingState } from '@ptbk/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useBrowser } from '../../app/browser-context';
import { useDebouncedSearch } from '../../app/debounced-search';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink, Link } from '../../app/link';
import { isForbidden, isStepUpRequired } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { Page } from '../shell/page';
import { useAllows } from '../../app/registry/use-visible-features';
import { AGENT_WIZARD_REQUIREMENT } from '../agent-wizard/agent-wizard-feature';
import { useAgentActions } from './agent-actions';
import { AgentAvatar } from './agent-avatar';
import { AgentStatusBadge, AgentVisibilityBadge, stateLabel, visibilityLabel } from './agent-badges';
import { AgentCreator } from './agent-creator';
import { BuiltInAgents } from './built-in-agents';
import { agentListParams, DEFAULT_AGENT_SORT } from './agent-list-search';
import type { AgentListSearch } from './agent-list-search';
import { agentListQueryOptions } from './agents-queries';

const route = getRouteApi('/agents/');

export const AGENT_COLUMNS_STORAGE_KEY = 'ptbk.agents.columns';
const NO_AGENTS: readonly Agent[] = [];
/** The previous-page cursor that means "the first page", which has no cursor of its own. */
const FIRST_PAGE = '';

type SortField = 'name' | 'updatedAt';
const SORTABLE: ReadonlySet<string> = new Set<SortField>(['name', 'updatedAt']);

function sortingOf(sort: AgentListSearch['sort']): SortingState {
    const desc = sort.startsWith('-');
    const id = desc ? sort.slice(1) : sort;
    return SORTABLE.has(id) ? [{ id, desc }] : [];
}

function sortOf(sorting: SortingState): AgentListSearch['sort'] {
    const [first] = sorting;
    if (first === undefined || !SORTABLE.has(first.id)) return DEFAULT_AGENT_SORT;
    const field = first.id as SortField;
    return first.desc ? `-${field}` : field;
}

/** Refusals the route explains as a whole page ("not allowed", "confirm it is you") rather than inside the table. */
function isPageLevel(error: unknown): boolean {
    const failure = classifyApiError(error);
    return isForbidden(failure) || isStepUpRequired(failure);
}

function isInvalidCursor(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.code === 'invalid-cursor';
}

/** Visibility only means something where agents can be shared (`agent-management@1`). */
function useAgentColumns(withVisibility: boolean): DataTableColumnDef<Agent>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<Agent>();
        return [
            column.accessor('name', {
                header: m.agents_column_name(),
                meta: { priority: 0 },
                enableHiding: false,
                cell: ({ row }) => (
                    <Link
                        to="/agents/$agentId"
                        params={{ agentId: row.original.id }}
                        variant="standalone"
                        className="inline-flex max-w-full items-center gap-2 font-medium"
                    >
                        <AgentAvatar
                            name={row.original.name}
                            agentKey={row.original.id}
                            profile={row.original.profile}
                        />
                        <span className="truncate">{row.original.name}</span>
                    </Link>
                ),
            }),
            column.accessor((agent) => agent.profile.description, {
                id: 'description',
                header: m.agents_column_description(),
                enableSorting: false,
                meta: { priority: 5 },
                cell: ({ getValue }) => (
                    <span className="line-clamp-2 max-w-sm text-text-muted">{getValue<string>()}</span>
                ),
            }),
            column.accessor('id', {
                id: 'status',
                header: m.agents_column_status(),
                enableSorting: false,
                meta: { priority: 1 },
                cell: ({ row }) => <AgentStatusBadge agentId={row.original.id} />,
            }),
            ...(withVisibility
                ? [
                      column.accessor('visibility', {
                          header: m.agents_column_visibility(),
                          enableSorting: false,
                          meta: { priority: 2 },
                          cell: ({ row }) => <AgentVisibilityBadge visibility={row.original.visibility} />,
                      }),
                  ]
                : []),
            column.accessor('createdBy', {
                header: m.agents_column_created_by(),
                enableSorting: false,
                meta: { priority: 4 },
                cell: ({ row }) => <AgentCreator memberId={row.original.createdBy} />,
            }),
            column.accessor('updatedAt', {
                header: m.agents_column_updated(),
                sortDescFirst: true,
                meta: { priority: 3 },
                cell: ({ row }) => <RelativeTime value={new Date(row.original.updatedAt)} />,
            }),
        ];
    }, [withVisibility]);
}

export function AgentsListPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const engineApi = useEngineApi();
    const { storage } = useBrowser();
    const canCreate = useAllows(AGENT_WIZARD_REQUIREMENT);
    const managesAgents = useAllows({ capability: KNOWN_CAPABILITIES.agentManagement });
    const searchRef = useRef<HTMLInputElement>(null);
    // The row whose menu opened the delete dialog disappears with the agent; focus then goes to the search box.
    const deletedId = useRef<string | null>(null);
    const actions = useAgentActions({
        onDeleted: (agent) => {
            deletedId.current = agent.id;
        },
    });
    const columns = useAgentColumns(managesAgents);
    const list = useQuery({
        ...agentListQueryOptions(engineApi, agentListParams(search)),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevel,
    });
    useEffect(() => {
        const id = deletedId.current;
        if (id === null || list.data === undefined || list.data.items.some((agent) => agent.id === id)) return;
        deletedId.current = null;
        searchRef.current?.focus();
    }, [list.data]);
    // Cursors only lead forward; remember where each page came from so "previous" can go back.
    const [previousCursors, setPreviousCursors] = useState<ReadonlyMap<string, string>>(() => new Map());

    const update = (change: Partial<AgentListSearch>, replace = false) => {
        void navigate({ search: (previous) => ({ ...previous, cursor: undefined, ...change }), replace });
    };
    const [text, setText] = useDebouncedSearch(search.q, (q) => {
        update({ q }, true);
    });

    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        // An expired or foreign cursor: start again from the first page instead of showing an error.
        if (invalidCursor) void navigate({ search: (previous) => ({ ...previous, cursor: undefined }), replace: true });
    }, [invalidCursor, navigate]);

    const filtered = search.q !== undefined || search.status !== undefined || search.visibility !== undefined;
    const newAgent = canCreate ? (
        <ButtonLink to="/agents/new" variant="primary">
            <Plus aria-hidden className="size-4" />
            {m.agents_new()}
        </ButtonLink>
    ) : null;
    const clear = () => {
        setText('');
        update({ q: undefined, status: undefined, visibility: undefined });
    };
    const clearFilters = <Button onClick={clear}>{m.agents_clear_filters()}</Button>;

    return (
        <Page title={m.agents_title()} actions={newAgent}>
            <LegacyFilterBar
                search={{
                    label: m.agents_search_label(),
                    placeholder: m.agents_search_placeholder(),
                    value: text,
                    onChange: setText,
                    maxLength: 256,
                    inputRef: searchRef,
                }}
                filters={[
                    {
                        kind: 'select',
                        id: 'status',
                        label: m.agents_column_status(),
                        allLabel: m.agents_filter_all_statuses(),
                        options: AGENT_RUN_STATES.map((state) => ({ value: state, label: stateLabel(state) })),
                        value: search.status,
                        onChange: (value) => {
                            update({ status: AGENT_RUN_STATES.find((state) => state === value) });
                        },
                    },
                    ...(managesAgents
                        ? [
                              {
                                  kind: 'select' as const,
                                  id: 'visibility',
                                  label: m.agents_column_visibility(),
                                  allLabel: m.agents_filter_all_visibilities(),
                                  options: AGENT_VISIBILITIES.map((visibility) => ({
                                      value: visibility,
                                      label: visibilityLabel(visibility),
                                  })),
                                  value: search.visibility,
                                  onChange: (value: string | undefined) => {
                                      update({
                                          visibility: AGENT_VISIBILITIES.find((visibility) => visibility === value),
                                      });
                                  },
                              },
                          ]
                        : []),
                ]}
                onClear={clear}
                empty={!list.isPending && search.cursor === undefined && list.data?.items.length === 0}
            />
            <DataTable
                caption={m.agents_title()}
                columns={columns}
                data={list.data?.items ?? NO_AGENTS}
                getRowId={(agent) => agent.id}
                getRowLabel={(agent) => agent.name}
                sorting={sortingOf(search.sort)}
                onSortingChange={(sorting) => {
                    update({ sort: sortOf(sorting) });
                }}
                visibilityStorage={{ storage, key: AGENT_COLUMNS_STORAGE_KEY }}
                page={{
                    previousCursor:
                        search.cursor === undefined ? null : (previousCursors.get(search.cursor) ?? FIRST_PAGE),
                    nextCursor: list.data?.nextCursor ?? null,
                }}
                onPageChange={(cursor, direction) => {
                    // A second click before the next page arrives would make the page its own predecessor.
                    if (cursor === search.cursor) return;
                    if (direction === 'next') {
                        setPreviousCursors((known) => new Map(known).set(cursor, search.cursor ?? FIRST_PAGE));
                    }
                    void navigate({
                        search: (previous) => ({ ...previous, cursor: cursor === FIRST_PAGE ? undefined : cursor }),
                    });
                }}
                loading={list.isPending}
                fetching={list.isFetching && !list.isPending}
                {...(list.isError && !invalidCursor
                    ? {
                          error: {
                              message: m.agents_load_failed(),
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
                              title: m.agents_no_results(),
                              description: m.agents_no_results_hint(),
                              action: clearFilters,
                          }
                        : {
                              title: m.agents_empty_title(),
                              description: canCreate ? m.agents_empty_body() : m.agents_empty_body_chat(),
                              ...(newAgent === null ? {} : { action: newAgent }),
                          }
                }
                rowActions={actions.menuEntries}
            />
            <BuiltInAgents q={search.q} />
            {actions.dialogs}
        </Page>
    );
}
