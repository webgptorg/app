import { ChatSource } from '@ptbk/engine-api';
import type { ReadChat } from '@ptbk/engine-api';
import { Badge, createDataTableColumnHelper, DataTable, RelativeTime, useLocale } from '@ptbk/ui';
import type { ColumnFiltersState, DataTableColumnDef } from '@ptbk/ui';
import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useBrowser } from '../../app/browser-context';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { isForbidden, isStepUpRequired } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { useAgentIdParam } from '../agents/agent-detail-route';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { chatListParams } from './chat-list-search';
import type { ChatListSearch } from './chat-list-search';
import { chatListQueryOptions } from './chat-queries';
import { chatName, sourceFilterOptions, sourceLabel } from './chat-source';
import { ChatStarter } from './chat-starter';

const route = getRouteApi('/agents/$agentId/chat/all');

export const CHAT_COLUMNS_STORAGE_KEY = 'ptbk.chats.columns';
const NO_CHATS: readonly ReadChat[] = [];
/** The previous-page cursor that means "the first page", which has no cursor of its own. */
const FIRST_PAGE = '';

function filtersOf(search: ChatListSearch): ColumnFiltersState {
    return search.source === undefined ? [] : [{ id: 'source', value: search.source }];
}

/** Refusals the route explains as a whole page rather than inside the table. */
function isPageLevel(error: unknown): boolean {
    const failure = classifyApiError(error);
    return isForbidden(failure) || isStepUpRequired(failure);
}

function isInvalidCursor(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.code === 'invalid-cursor';
}

function useChatColumns(agentId: string): DataTableColumnDef<ReadChat>[] {
    const formatters = useLocale();
    return useMemo(() => {
        const column = createDataTableColumnHelper<ReadChat>();
        return [
            column.accessor((chat) => chatName(chat), {
                id: 'title',
                header: m.chat_column_title(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0 },
                cell: ({ row }) => (
                    <Link
                        to="/agents/$agentId/chat/$chatId"
                        params={{ agentId, chatId: row.original.id }}
                        variant="standalone"
                        className="line-clamp-2 max-w-md font-medium break-words"
                    >
                        {chatName(row.original)}
                    </Link>
                ),
            }),
            column.accessor('source', {
                header: m.chat_column_source(),
                enableSorting: false,
                meta: {
                    priority: 1,
                    filter: { kind: 'select', allLabel: m.chat_filter_all_sources(), options: sourceFilterOptions() },
                },
                cell: ({ row }) => <Badge>{sourceLabel(row.original.source)}</Badge>,
            }),
            column.accessor('createdBy', {
                header: m.chat_column_started_by(),
                enableSorting: false,
                meta: { priority: 2 },
                cell: ({ row }) => <ChatStarter chat={row.original} />,
            }),
            column.accessor('lastMessageAt', {
                header: m.chat_column_last_message(),
                enableSorting: false,
                meta: { priority: 3 },
                cell: ({ row }) =>
                    row.original.lastMessageAt === null ? (
                        <span aria-hidden="true">{'—'}</span>
                    ) : (
                        <RelativeTime value={new Date(row.original.lastMessageAt)} />
                    ),
            }),
            column.accessor('messageCount', {
                header: m.chat_column_messages(),
                enableSorting: false,
                meta: { priority: 4 },
                cell: ({ row }) => <span>{formatters.formatNumber(row.original.messageCount)}</span>,
            }),
        ];
    }, [agentId, formatters]);
}

/**
 * Every chat of the agent, whoever started it (other members, public visitors, API clients), newest activity first.
 * The source filter and the cursor live in the URL, so a filtered page can be linked and survives a reload.
 */
export function ChatTablePage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const engineApi = useEngineApi();
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(engineApi, agentId));
    const { storage } = useBrowser();
    const columns = useChatColumns(agentId);
    const list = useQuery({
        ...chatListQueryOptions(engineApi, agentId, chatListParams(search)),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevel,
    });
    // Cursors only lead forward; remember where each page came from so "previous" can go back.
    const [previousCursors, setPreviousCursors] = useState<ReadonlyMap<string, string>>(() => new Map());

    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        // An expired or foreign cursor: start again from the first page instead of showing an error.
        if (invalidCursor) void navigate({ search: (previous) => ({ ...previous, cursor: undefined }), replace: true });
    }, [invalidCursor, navigate]);

    return (
        <div className="flex min-w-0 flex-col gap-6">
            <DataTable
                caption={m.chat_list_label({ name: agent.name })}
                columns={columns}
                data={list.data?.items ?? NO_CHATS}
                getRowId={(chat) => chat.id}
                getRowLabel={(chat) => chatName(chat)}
                columnFilters={filtersOf(search)}
                onColumnFiltersChange={(filters) => {
                    const value = filters.find((filter) => filter.id === 'source')?.value;
                    const source = ChatSource.safeParse(value).data;
                    void navigate({ search: (previous) => ({ ...previous, cursor: undefined, source }) });
                }}
                visibilityStorage={{ storage, key: CHAT_COLUMNS_STORAGE_KEY }}
                page={{
                    previousCursor:
                        search.cursor === undefined ? null : (previousCursors.get(search.cursor) ?? FIRST_PAGE),
                    nextCursor: list.data?.nextCursor ?? null,
                }}
                onPageChange={(cursor, direction) => {
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
                              message: m.chat_load_failed(),
                              onRetry: () => {
                                  void list.refetch();
                              },
                              retrying: list.isFetching,
                          },
                      }
                    : {})}
                empty={{ title: m.chat_empty_title(), description: m.chat_empty_body({ name: agent.name }) }}
            />
        </div>
    );
}
