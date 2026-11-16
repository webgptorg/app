import { AGENT_RUN_STATES, AGENT_VISIBILITIES, FolderId, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { Agent, AgentRunState, AgentVisibility } from '@ptbk/engine-api';
import {
    BrandRobot,
    Button,
    createDataTableColumnHelper,
    DataTable,
    EmptyState,
    ErrorState,
    FilterBar,
    filterField,
    Pagination,
    RelativeTime,
    viewTransitionStyle,
} from '@ptbk/ui';
import type { DataTableColumnDef, DataTableView, FilterBarField, SortingState } from '@ptbk/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Bot, CalendarClock, CircleDot, Eye, Folder, Layers, Plus, Text, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useBrowser } from '../../app/browser-context';
import { useDebouncedSearch } from '../../app/debounced-search';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { isForbidden, isStepUpRequired } from '../../app/mutations';
import { useAllows } from '../../app/registry/use-visible-features';
import { readOneParam } from '../../app/search-filters';
import { m } from '../../paraglide/messages';
import { AGENT_WIZARD_REQUIREMENT } from '../agent-wizard/agent-wizard-feature';
import { Page } from '../shell/page';
import { useAgentActions } from './agent-actions';
import { AgentAvatar } from './agent-avatar';
import { AgentVisibilityBadge, stateLabel, VisibilityIcon, visibilityLabel } from './agent-badges';
import { AgentActivityContext, useAgentActivity, useAgentActivityOf } from './agent-activity';
import { AgentStatusPill } from './agent-status';
import { AgentCreator } from './agent-creator';
import {
    AGENT_LIST_ORIGINS,
    agentListGroups,
    agentListParams,
    builtInAgentParams,
    DEFAULT_AGENT_SORT,
    hasAgentFilters,
} from './agent-list-search';
import type { AgentListOrigin, AgentListSearch } from './agent-list-search';
import { agentListQueryOptions, folderListQueryOptions } from './agents-queries';
import { AgentsGridView } from './agents-grid-view';
import { resolveAgentView, rememberAgentView } from './agent-view';
import type { AgentView } from './agent-view';
import { AgentViewSwitch } from './agent-view-switch';

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

export function isBuiltInAgent(agent: Pick<Agent, 'origin'>): boolean {
    return agent.origin !== 'content';
}

function originLabel(origin: AgentListOrigin): string {
    return origin === 'own' ? m.agents_group_own() : m.agents_group_built_in();
}

/** Avatar and name, the way into the agent; the name morphs into the agent page's title. */
function AgentNameCell({ agent }: { readonly agent: Agent }) {
    return (
        <Link
            to="/agents/$agentId"
            params={{ agentId: agent.id }}
            className="inline-flex max-w-full min-w-0 items-center gap-2.5 rounded-control font-medium text-text hover:underline"
        >
            <AgentAvatar name={agent.name} agentKey={agent.id} profile={agent.profile} origin={agent.origin} />
            {/* Names come from Books: React renders them as text. */}
            <span className="truncate" style={viewTransitionStyle('agent-title', agent.id)}>
                {agent.name}
            </span>
        </Link>
    );
}

function StatusCell({ agentId }: { readonly agentId: Agent['id'] }) {
    return <AgentStatusPill agentId={agentId} activity={useAgentActivityOf(agentId)} />;
}

/** Visibility only means something where agents can be shared (`agent-management@1`). */
function useAgentColumns(withVisibility: boolean): DataTableColumnDef<Agent>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<Agent>();
        return [
            column.accessor('name', {
                header: m.agents_column_name(),
                meta: { icon: <Bot className="size-3.5" />, priority: 0 },
                enableHiding: false,
                cell: ({ row }) => <AgentNameCell agent={row.original} />,
            }),
            column.accessor((agent) => agent.profile.description, {
                id: 'description',
                header: m.agents_column_role(),
                enableSorting: false,
                meta: { icon: <Text className="size-3.5" />, priority: 5 },
                cell: ({ getValue }) => (
                    <span className="line-clamp-1 max-w-md break-words text-text-muted">{getValue<string>()}</span>
                ),
            }),
            column.accessor('id', {
                id: 'status',
                header: m.agents_column_status(),
                enableSorting: false,
                meta: { icon: <CircleDot className="size-3.5" />, priority: 1, trailing: true },
                cell: ({ row }) => <StatusCell agentId={row.original.id} />,
            }),
            ...(withVisibility
                ? [
                      column.accessor('visibility', {
                          header: m.agents_column_visibility(),
                          enableSorting: false,
                          meta: { icon: <Eye className="size-3.5" />, priority: 3 },
                          cell: ({ row }) => <AgentVisibilityBadge visibility={row.original.visibility} />,
                      }),
                  ]
                : []),
            column.accessor('createdBy', {
                header: m.agents_column_created_by(),
                enableSorting: false,
                meta: { icon: <UserRound className="size-3.5" />, priority: 4 },
                // The engine prepares its own agents; nobody on the team created them.
                cell: ({ row }) =>
                    isBuiltInAgent(row.original) ? null : (
                        <span className="text-text-muted">
                            <AgentCreator memberId={row.original.createdBy} />
                        </span>
                    ),
            }),
            column.accessor('updatedAt', {
                header: m.agents_column_updated(),
                sortDescFirst: true,
                meta: { icon: <CalendarClock className="size-3.5" />, priority: 2, numeric: true },
                cell: ({ row }) => (
                    <RelativeTime
                        value={new Date(row.original.updatedAt)}
                        className="whitespace-nowrap text-text-muted"
                    />
                ),
            }),
        ];
    }, [withVisibility]);
}

/**
 * The member's agents and, as a group of the same table, the engine's built-in ones. Search, filters, sort and page
 * live in the URL; the engine does all the filtering and ordering.
 */
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
    // Three lists for the whole page, shared by every row and card, so the views say the same about each agent.
    const activity = useAgentActivity();
    const shown = agentListGroups(search);
    const own = useQuery({
        ...agentListQueryOptions(engineApi, agentListParams(search)),
        enabled: shown.own,
        placeholderData: keepPreviousData,
        throwOnError: isPageLevel,
    });
    // Quiet when it fails: the member's own agents are what the page is for, and the built-in ones are a chat away.
    const builtIn = useQuery({
        ...agentListQueryOptions(engineApi, builtInAgentParams(search)),
        enabled: shown.builtIn,
        placeholderData: keepPreviousData,
    });
    const ownAgents = shown.own ? (own.data?.items ?? NO_AGENTS) : NO_AGENTS;
    const builtInAgents = shown.builtIn ? (builtIn.data?.items ?? NO_AGENTS) : NO_AGENTS;
    const rows = useMemo(() => [...ownAgents, ...builtInAgents], [ownAgents, builtInAgents]);

    useEffect(() => {
        const id = deletedId.current;
        if (id === null || own.data === undefined || own.data.items.some((agent) => agent.id === id)) return;
        deletedId.current = null;
        searchRef.current?.focus();
    }, [own.data]);
    // Cursors only lead forward; remember where each page came from so "previous" can go back.
    const [previousCursors, setPreviousCursors] = useState<ReadonlyMap<string, string>>(() => new Map());

    const update = (change: Partial<AgentListSearch>, replace = false) => {
        void navigate({ search: (previous) => ({ ...previous, cursor: undefined, ...change }), replace });
    };

    const invalidCursor = own.isError && isInvalidCursor(own.error);
    useEffect(() => {
        // An expired or foreign cursor: start again from the first page instead of showing an error.
        if (invalidCursor) void navigate({ search: (previous) => ({ ...previous, cursor: undefined }), replace: true });
    }, [invalidCursor, navigate]);

    const previousCursor = search.cursor === undefined ? null : (previousCursors.get(search.cursor) ?? FIRST_PAGE);
    const nextCursor = own.data?.nextCursor ?? null;
    const goToPage = (cursor: string, direction: 'previous' | 'next') => {
        // A second click before the next page arrives would make the page its own predecessor.
        if (cursor === search.cursor) return;
        if (direction === 'next') {
            setPreviousCursors((known) => new Map(known).set(cursor, search.cursor ?? FIRST_PAGE));
        }
        void navigate({
            search: (previous) => ({ ...previous, cursor: cursor === FIRST_PAGE ? undefined : cursor }),
        });
    };
    const view = resolveAgentView(search.view, storage);
    const changeView = (next: AgentView) => {
        rememberAgentView(next, storage);
        void navigate({ search: (previous) => ({ ...previous, view: next, agent: undefined }), replace: true });
    };

    const filtered = hasAgentFilters(search);
    const newAgent = canCreate ? (
        <ButtonLink to="/agents/new" variant="primary">
            <Plus aria-hidden className="size-4" />
            {m.agents_new()}
        </ButtonLink>
    ) : null;
    const clear = () => {
        update({ q: undefined, status: undefined, visibility: undefined, origin: undefined, folderId: undefined });
    };
    // The built-in group keeps the table from ever being empty, so the invitation to make one's own sits above it.
    const noOwnAgents =
        !filtered &&
        shown.own &&
        search.cursor === undefined &&
        own.data?.items.length === 0 &&
        own.data.nextCursor === null &&
        builtInAgents.length > 0;
    const pending = shown.own ? own.isPending : builtIn.isPending;

    const emptyState = filtered ? (
        <EmptyState
            icon={<Bot aria-hidden />}
            title={m.agents_no_results()}
            description={m.agents_no_results_hint()}
            action={<Button onClick={clear}>{m.agents_clear_filters()}</Button>}
        />
    ) : (
        <EmptyState
            icon={<Bot aria-hidden />}
            illustration={<BrandRobot pose="assembling" />}
            title={m.agents_empty_title()}
            description={canCreate ? m.agents_empty_body() : m.agents_empty_body_chat()}
            action={newAgent ?? undefined}
        />
    );
    // With no agent at all and nothing filtered, there is nothing to search: the bar steps aside for the invitation.
    const nothing = !filtered && !pending && search.cursor === undefined && rows.length === 0;
    const filters = (tableView: DataTableView) => (
        <AgentFilters
            view={tableView}
            empty={nothing}
            search={search}
            managesAgents={managesAgents}
            searchRef={searchRef}
            onChange={(change) => {
                update(change, 'q' in change);
            }}
            onClear={clear}
        />
    );
    const header = (
        <>
            <AgentViewSwitch view={view} onChange={changeView} />
            {newAgent}
        </>
    );

    if (view === 'grid') {
        return (
            <AgentActivityContext value={activity}>
                <Page title={m.agents_title()} actions={header}>
                    {filters({})}
                    {noOwnAgents ? (
                        <EmptyState
                            variant="inline"
                            icon={<Bot aria-hidden />}
                            title={m.agents_empty_title()}
                            description={canCreate ? m.agents_empty_body() : m.agents_empty_body_chat()}
                        />
                    ) : null}
                    {shown.own && own.isError && !invalidCursor ? (
                        <ErrorState
                            message={m.agents_load_failed()}
                            onRetry={() => {
                                void own.refetch();
                            }}
                            retrying={own.isFetching}
                        />
                    ) : (
                        <AgentsGridView
                            activity={activity}
                            own={ownAgents}
                            builtIn={builtInAgents}
                            showOwn={shown.own && !noOwnAgents}
                            loading={pending}
                            openId={search.agent ?? null}
                            onOpenChange={(agent) => {
                                void navigate({ search: (previous) => ({ ...previous, agent }) });
                            }}
                            pager={
                                previousCursor === null && nextCursor === null ? null : (
                                    <Pagination
                                        hasPrevious={previousCursor !== null}
                                        hasNext={nextCursor !== null}
                                        onPrevious={() => {
                                            if (previousCursor !== null) goToPage(previousCursor, 'previous');
                                        }}
                                        onNext={() => {
                                            if (nextCursor !== null) goToPage(nextCursor, 'next');
                                        }}
                                    />
                                )
                            }
                            empty={emptyState}
                        />
                    )}
                    {actions.dialogs}
                </Page>
            </AgentActivityContext>
        );
    }

    return (
        <AgentActivityContext value={activity}>
            <Page title={m.agents_title()} actions={header}>
                {noOwnAgents ? (
                    <EmptyState
                        variant="inline"
                        icon={<Bot aria-hidden />}
                        title={m.agents_empty_title()}
                        description={canCreate ? m.agents_empty_body() : m.agents_empty_body_chat()}
                    />
                ) : null}
                <DataTable
                    caption={m.agents_title()}
                    columns={columns}
                    data={rows}
                    getRowId={(agent) => agent.id}
                    getRowLabel={(agent) => agent.name}
                    sorting={sortingOf(search.sort)}
                    sortingRemoval={false}
                    onSortingChange={(sorting) => {
                        update({ sort: sortOf(sorting) });
                    }}
                    visibilityStorage={{ storage, key: AGENT_COLUMNS_STORAGE_KEY }}
                    {...(shown.own ? { page: { previousCursor, nextCursor } } : {})}
                    onPageChange={goToPage}
                    loading={pending}
                    fetching={(own.isFetching && !own.isPending) || (builtIn.isFetching && !builtIn.isPending)}
                    {...(shown.own && own.isError && !invalidCursor
                        ? {
                              error: {
                                  message: m.agents_load_failed(),
                                  onRetry: () => {
                                      void own.refetch();
                                  },
                                  retrying: own.isFetching,
                              },
                          }
                        : {})}
                    empty={
                        filtered
                            ? {
                                  title: m.agents_no_results(),
                                  description: m.agents_no_results_hint(),
                                  action: <Button onClick={clear}>{m.agents_clear_filters()}</Button>,
                              }
                            : {
                                  illustration: <BrandRobot pose="assembling" />,
                                  title: m.agents_empty_title(),
                                  description: canCreate ? m.agents_empty_body() : m.agents_empty_body_chat(),
                                  ...(newAgent === null ? {} : { action: newAgent }),
                              }
                    }
                    groups={{
                        groups: AGENT_LIST_ORIGINS.map((origin) => ({ id: origin, label: originLabel(origin) })),
                        getGroupId: (agent): AgentListOrigin => (isBuiltInAgent(agent) ? 'built-in' : 'own'),
                    }}
                    toolbar={filters}
                    rowActions={actions.menuEntries}
                />
                {actions.dialogs}
            </Page>
        </AgentActivityContext>
    );
}

/** Every filter lives in the URL, so a reload or a shared link restores the view. */
function AgentFilters({
    view,
    search,
    managesAgents,
    searchRef,
    empty,
    onChange,
    onClear,
}: {
    readonly view: DataTableView;
    readonly empty: boolean;
    readonly search: AgentListSearch;
    readonly managesAgents: boolean;
    readonly searchRef: RefObject<HTMLInputElement | null>;
    readonly onChange: (change: Partial<AgentListSearch>) => void;
    readonly onClear: () => void;
}) {
    const [text, setText] = useDebouncedSearch(search.q, (q) => {
        onChange({ q });
    });
    const folders = useQuery(folderListQueryOptions(useEngineApi())).data ?? [];
    const fields: FilterBarField[] = [
        filterField.enum<AgentRunState>({
            id: 'status',
            label: m.agents_column_status(),
            icon: <CircleDot className="size-3.5" />,
            options: AGENT_RUN_STATES.map((state) => ({ value: state, label: stateLabel(state) })),
            value: search.status,
            onChange: (status) => {
                onChange({ status });
            },
        }),
        filterField.enum<AgentListOrigin>({
            id: 'origin',
            label: m.agents_filter_origin(),
            icon: <Layers className="size-3.5" />,
            options: AGENT_LIST_ORIGINS.map((origin) => ({ value: origin, label: originLabel(origin) })),
            value: search.origin,
            onChange: (origin) => {
                onChange({ origin });
            },
        }),
        ...(managesAgents
            ? [
                  filterField.enum<AgentVisibility>({
                      id: 'visibility',
                      label: m.agents_column_visibility(),
                      icon: <Eye className="size-3.5" />,
                      options: AGENT_VISIBILITIES.map((visibility) => ({
                          value: visibility,
                          label: visibilityLabel(visibility),
                          icon: <VisibilityIcon visibility={visibility} />,
                      })),
                      value: search.visibility,
                      onChange: (visibility) => {
                          onChange({ visibility });
                      },
                  }),
              ]
            : []),
        // Only where the engine has folders: an empty field would offer a choice with nothing in it.
        ...(folders.length === 0 && search.folderId === undefined
            ? []
            : [
                  filterField.entity<string>({
                      id: 'folder',
                      label: m.agents_filter_folder(),
                      icon: <Folder className="size-3.5" />,
                      multiple: false,
                      options: folders.map((folder) => ({ value: folder.id, label: folder.name })),
                      value: readOneParam(search.folderId),
                      onChange: (value) => {
                          const picked = value.at(-1);
                          onChange({ folderId: picked === undefined ? undefined : FolderId.safeParse(picked).data });
                      },
                  }),
              ]),
    ];
    return (
        <FilterBar
            {...view}
            label={m.agents_filters()}
            search={{
                label: m.agents_search_label(),
                placeholder: m.agents_search_placeholder(),
                value: text,
                onChange: setText,
                maxLength: 256,
                inputRef: searchRef,
            }}
            fields={fields}
            empty={empty}
            onClear={() => {
                setText('');
                onClear();
            }}
        />
    );
}
