import type { Member } from '@ptbk/engine-api';
import { Badge, createDataTableColumnHelper, DataTable, RelativeTime, useLocale } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { isInvalidCursor, isPageLevelFailure } from '../../app/list-errors';
import { m } from '../../paraglide/messages';
import { useCurrentMember } from '../session/use-current-member';
import { Page } from '../shell/page';
import { roleLabel } from '../shell/role-label';
import { memberListParams } from './member-list-search';
import { memberListQueryOptions } from './members-queries';

const route = getRouteApi('/members');

export const MEMBER_COLUMNS_STORAGE_KEY = 'ptbk.members.columns';
const NO_MEMBERS: readonly Member[] = [];

function PasskeyCount({ count }: { readonly count: number | null }) {
    const locale = useLocale();
    return count === null ? (
        <span className="text-text-muted">{m.security_not_reported()}</span>
    ) : (
        <span className="tabular-nums">{locale.formatNumber(count)}</span>
    );
}

function useMemberColumns(myId: string): DataTableColumnDef<Member>[] {
    return useMemo(() => {
        const column = createDataTableColumnHelper<Member>();
        return [
            column.accessor('displayName', {
                header: m.members_column_name(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0 },
                cell: ({ row }) => (
                    <span className="inline-flex flex-wrap items-center gap-2 font-medium">
                        {row.original.displayName}
                        {row.original.id === myId ? <Badge tone="accent">{m.members_you()}</Badge> : null}
                    </span>
                ),
            }),
            column.accessor('role', {
                header: m.members_column_role(),
                enableSorting: false,
                meta: { priority: 1 },
                cell: ({ row }) => roleLabel(row.original.role),
            }),
            column.accessor('passkeyCount', {
                header: m.members_column_passkeys(),
                enableSorting: false,
                meta: { priority: 3 },
                cell: ({ row }) => <PasskeyCount count={row.original.passkeyCount} />,
            }),
            column.accessor('lastSeenAt', {
                header: m.members_column_last_seen(),
                enableSorting: false,
                meta: { priority: 2 },
                cell: ({ row }) =>
                    row.original.lastSeenAt === null ? (
                        <span className="text-text-muted">{m.members_never_seen()}</span>
                    ) : (
                        <RelativeTime value={new Date(row.original.lastSeenAt)} />
                    ),
            }),
            column.accessor('createdAt', {
                header: m.members_column_joined(),
                enableSorting: false,
                meta: { priority: 4 },
                cell: ({ row }) => <RelativeTime value={new Date(row.original.createdAt)} />,
            }),
        ];
    }, [myId]);
}

/** Read-only in v0: no invites or role changes, and no row actions until v1 adds them (C-04 drafts). */
export function MembersPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const { storage } = useBrowser();
    const me = useCurrentMember();
    const columns = useMemberColumns(me.memberId);
    const list = useQuery({
        ...memberListQueryOptions(useEngineApi(), memberListParams(search)),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevelFailure,
    });
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        void navigate({ search: { cursor } });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) void navigate({ search: {}, replace: true });
    }, [invalidCursor, navigate]);

    return (
        <Page title={m.members_title()}>
            <DataTable
                caption={m.members_title()}
                columns={columns}
                data={list.data?.items ?? NO_MEMBERS}
                getRowId={(member) => member.id}
                getRowLabel={(member) => member.displayName}
                visibilityStorage={{ storage, key: MEMBER_COLUMNS_STORAGE_KEY }}
                page={paging.page}
                onPageChange={paging.onPageChange}
                loading={list.isPending}
                fetching={list.isFetching && !list.isPending}
                {...(list.isError && !invalidCursor
                    ? {
                          error: {
                              message: m.members_load_failed(),
                              onRetry: () => {
                                  void list.refetch();
                              },
                              retrying: list.isFetching,
                          },
                      }
                    : {})}
                empty={{ title: m.members_empty_title(), description: m.members_empty_body() }}
            />
        </Page>
    );
}
