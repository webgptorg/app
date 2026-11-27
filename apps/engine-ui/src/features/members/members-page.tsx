import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { Member } from '@ptbk/engine-api';
import {
    Avatar,
    Badge,
    buttonClassName,
    ConfirmDialog,
    createDataTableColumnHelper,
    DataTable,
    EmptyState,
    RelativeTime,
    Section,
    useLocale,
} from '@ptbk/ui';
import type { DataTableColumnDef, MenuEntry } from '@ptbk/ui';
import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import {
    CalendarClock,
    Clock,
    ExternalLink,
    KeyRound,
    Shield,
    UserMinus,
    UserPlus,
    UserRound,
    UserRoundCog,
    Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useBrowser } from '../../app/browser-context';
import { useCursorPages } from '../../app/cursor-pages';
import { useEngineApi } from '../../app/engine-api-context';
import { isInvalidCursor, isPageLevelFailure } from '../../app/list-errors';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { engineInfoQueryOptions } from '../engine/engine-queries';
import { useCurrentMember } from '../session/use-current-member';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { dashboardLinks } from '../shell/dashboard-links';
import { roleLabel } from '../shell/role-label';
import { AccessRequests } from './access-requests';
import { memberListParams } from './member-list-search';
import { ChangeRoleDialog } from './member-dialogs';
import { accessRequestListQueryOptions, inviteListQueryOptions, memberListQueryOptions } from './members-queries';
import { PendingInvites } from './pending-invites';
import { useMemberMutations } from './use-member-mutations';

const route = getRouteApi('/members');

export const MEMBER_COLUMNS_STORAGE_KEY = 'ptbk.members.columns';
const NO_MEMBERS: readonly Member[] = [];
const ICON = 'size-3.5';

function PasskeyCount({ count }: { readonly count: number | null }) {
    const locale = useLocale();
    return count === null ? (
        <span className="text-text-muted">{m.security_not_reported()}</span>
    ) : (
        <span className="text-text-muted tabular-nums">{locale.formatNumber(count)}</span>
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
                meta: { icon: <UserRound className={ICON} />, priority: 0, grow: true },
                cell: ({ row }) => (
                    <span className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={row.original.displayName} size="sm" />
                        {/* Display names are whatever the person or their organization chose: text only. */}
                        <span className="min-w-0 truncate font-medium">{row.original.displayName}</span>
                        {row.original.id === myId ? (
                            <span className="shrink-0 text-xs text-text-muted">{m.members_you()}</span>
                        ) : null}
                        {row.original.dashboardUserId === null ? null : (
                            <span className="hidden shrink-0 text-xs text-text-muted sm:inline">
                                {m.members_via_organization()}
                            </span>
                        )}
                    </span>
                ),
            }),
            column.accessor('role', {
                header: m.members_column_role(),
                enableSorting: false,
                meta: { icon: <Shield className={ICON} />, priority: 1, trailing: true },
                cell: ({ row }) => <Badge>{roleLabel(row.original.role)}</Badge>,
            }),
            column.accessor('passkeyCount', {
                header: m.members_column_passkeys(),
                enableSorting: false,
                meta: { icon: <KeyRound className={ICON} />, priority: 4, numeric: true, hideOnCard: true },
                cell: ({ row }) => <PasskeyCount count={row.original.passkeyCount} />,
            }),
            column.accessor('lastSeenAt', {
                header: m.members_column_last_seen(),
                enableSorting: false,
                meta: { icon: <Clock className={ICON} />, priority: 2, numeric: true },
                cell: ({ row }) =>
                    row.original.lastSeenAt === null ? (
                        <span className="text-text-muted">{m.members_never_seen()}</span>
                    ) : (
                        <RelativeTime
                            value={new Date(row.original.lastSeenAt)}
                            className="whitespace-nowrap text-text-muted"
                        />
                    ),
            }),
            column.accessor('createdAt', {
                header: m.members_column_joined(),
                enableSorting: false,
                meta: { icon: <CalendarClock className={ICON} />, priority: 3, numeric: true, hideOnCard: true },
                cell: ({ row }) => (
                    <RelativeTime
                        value={new Date(row.original.createdAt)}
                        className="whitespace-nowrap text-text-muted"
                    />
                ),
            }),
        ];
    }, [myId]);
}

type Pending =
    { readonly kind: 'role'; readonly member: Member } | { readonly kind: 'remove'; readonly member: Member };

/**
 * Everyone has a dashboard account, so people are invited there: the dashboard's ticket brings them back as an access
 * request. The engine's own invite links (`POST /invites`) stay in the API for engines without a dashboard.
 */
function InviteInDashboard({ href }: { readonly href: string }) {
    return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClassName('primary', 'md')}>
            <UserPlus aria-hidden className="size-4" />
            {m.members_invite_in_dashboard()}
            <ExternalLink aria-hidden className="size-3.5" />
            <span className="sr-only">{` ${m.ui_opens_in_new_tab()}`}</span>
        </a>
    );
}

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
    const { data: engine } = useSuspenseQuery(engineInfoQueryOptions(engineApi));
    // The bundle names no outside origin, so the link appears once the engine reports the dashboard it is linked to.
    const inviteUrl = dashboardLinks(engine.dashboardUrl).allEngines;
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
    const requestsSupported = useAllows({ capability: KNOWN_CAPABILITIES.accessRequests });
    const accessRequests = useQuery({ ...accessRequestListQueryOptions(engineApi), enabled: requestsSupported });
    const invitesUnsupported = invites.isError && isUnsupported(invites.error);
    const managing = canManage && !invitesUnsupported;
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        void navigate({ search: { cursor } });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) void navigate({ search: ({ request }) => ({ request }), replace: true });
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

    const inviteButton = canManage && inviteUrl !== null ? <InviteInDashboard href={inviteUrl} /> : null;
    const alone =
        list.data !== undefined &&
        list.data.nextCursor === null &&
        search.cursor === undefined &&
        list.data.items.every((member) => member.id === me.memberId);

    let intro: string;
    if (!canManage) intro = m.members_intro_read_only();
    else if (invitesUnsupported) intro = m.members_intro_no_invites();
    else intro = m.members_intro();

    // A quiet heading over the people only once something sits above them, so the list reads as its own section.
    const requestsWaiting = requestsSupported && (accessRequests.data?.items.length ?? 0) > 0;
    return (
        <Page title={m.members_title()} description={intro} actions={inviteButton}>
            {requestsSupported ? (
                <AccessRequests
                    query={accessRequests}
                    canManage={canManage}
                    mutations={mutations}
                    linkedRequestId={search.request}
                    onLinkClosed={() => {
                        void navigate({ search: ({ cursor }) => ({ cursor }), replace: true });
                    }}
                />
            ) : null}
            <Section {...(requestsWaiting ? { title: m.members_people() } : {})} divided={requestsWaiting}>
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
                    empty={{ icon: <Users />, title: m.members_empty_title(), description: m.members_empty_body() }}
                    {...(managing ? { rowActions } : {})}
                />
            </Section>
            {invitesUnsupported ? null : <PendingInvites query={invites} canManage={canManage} mutations={mutations} />}
            {canManage && alone ? (
                <EmptyState
                    headingLevel={2}
                    icon={<UserPlus />}
                    title={m.invites_empty_title()}
                    description={m.invites_empty_body()}
                    {...(inviteUrl === null ? {} : { action: <InviteInDashboard href={inviteUrl} /> })}
                />
            ) : null}
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
