import type { Member } from '@ptbk/engine-api';
import {
    Badge,
    Button,
    ConfirmDialog,
    createDataTableColumnHelper,
    DataTable,
    EmptyState,
    RelativeTime,
    useLocale,
} from '@ptbk/ui';
import type { DataTableColumnDef, MenuEntry } from '@ptbk/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { UserMinus, UserPlus, UserRoundCog } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { isInvalidCursor, isPageLevelFailure } from '../../app/list-errors';
import { m } from '../../paraglide/messages';
import { useCurrentMember } from '../session/use-current-member';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { roleLabel } from '../shell/role-label';
import { memberListParams } from './member-list-search';
import { ChangeRoleDialog, InviteDialog } from './member-dialogs';
import { inviteListQueryOptions, memberListQueryOptions } from './members-queries';
import { PendingInvites } from './pending-invites';
import { useMemberMutations } from './use-member-mutations';

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

type Pending =
    | { readonly kind: 'invite' }
    | { readonly kind: 'role'; readonly member: Member }
    | { readonly kind: 'remove'; readonly member: Member };

/** Invites are a draft route: an engine that has not built them answers 404 `not-found`. */
function isUnsupported(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.code === 'not-found';
}

export function MembersPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const { storage } = useBrowser();
    const engineApi = useEngineApi();
    const me = useCurrentMember();
    const { can } = usePermissions();
    const canManage = can('members.manage');
    const mutations = useMemberMutations();
    const [pending, setPending] = useState<Pending | null>(null);
    const close = () => {
        setPending(null);
    };
    const columns = useMemberColumns(me.memberId);
    const list = useQuery({
        ...memberListQueryOptions(engineApi, memberListParams(search)),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevelFailure,
    });
    const invites = useQuery(inviteListQueryOptions(engineApi));
    const invitesUnsupported = invites.isError && isUnsupported(invites.error);
    const managing = canManage && !invitesUnsupported;
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        void navigate({ search: { cursor } });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) void navigate({ search: {}, replace: true });
    }, [invalidCursor, navigate]);

    // Nobody changes or removes themselves here; everything else is the engine's policy to allow or refuse.
    const rowActions = (member: Member): MenuEntry[] => {
        if (member.id === me.memberId) return [];
        return [
            {
                kind: 'item',
                id: 'role',
                label: m.members_change_role(),
                icon: <UserRoundCog />,
                onSelect: () => {
                    setPending({ kind: 'role', member });
                },
            },
            { kind: 'separator', id: 'danger' },
            {
                kind: 'item',
                id: 'remove',
                label: m.members_remove(),
                icon: <UserMinus />,
                tone: 'danger',
                onSelect: () => {
                    setPending({ kind: 'remove', member });
                },
            },
        ];
    };

    const inviteButton = managing ? (
        <Button
            variant="primary"
            onClick={() => {
                setPending({ kind: 'invite' });
            }}
        >
            <UserPlus aria-hidden className="size-4" />
            {m.invites_new()}
        </Button>
    ) : null;
    const alone =
        list.data !== undefined &&
        list.data.nextCursor === null &&
        search.cursor === undefined &&
        list.data.items.every((member) => member.id === me.memberId);
    const noInvites = invites.data !== undefined && invites.data.items.length === 0;

    let intro: string;
    if (!canManage) intro = m.members_intro_read_only();
    else if (invitesUnsupported) intro = m.members_intro_no_invites();
    else intro = m.members_intro();

    return (
        <Page title={m.members_title()} actions={inviteButton}>
            <p className="text-sm text-text-muted">{intro}</p>
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
                {...(managing ? { rowActions } : {})}
            />
            {invitesUnsupported ? null : <PendingInvites query={invites} canManage={canManage} mutations={mutations} />}
            {managing && alone && noInvites ? (
                <EmptyState
                    headingLevel={2}
                    icon={<UserPlus />}
                    title={m.invites_empty_title()}
                    description={m.invites_empty_body()}
                    action={
                        <Button
                            onClick={() => {
                                setPending({ kind: 'invite' });
                            }}
                        >
                            {m.invites_new()}
                        </Button>
                    }
                />
            ) : null}
            {pending?.kind === 'invite' ? <InviteDialog mutations={mutations} onClose={close} /> : null}
            {pending?.kind === 'role' ? (
                <ChangeRoleDialog member={pending.member} mutations={mutations} onClose={close} />
            ) : null}
            {pending?.kind === 'remove' ? (
                <ConfirmDialog
                    open
                    onClose={close}
                    tone="danger"
                    title={m.members_remove_title({ name: pending.member.displayName })}
                    description={m.members_remove_body()}
                    confirmLabel={m.members_remove()}
                    loading={mutations.remove.isPending}
                    onConfirm={() => {
                        mutations.remove.mutate(pending.member, { onSuccess: close });
                    }}
                />
            ) : null}
        </Page>
    );
}
