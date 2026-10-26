import type { Member, ReadAuditEntry } from '@ptbk/engine-api';
import { Badge, Button, createDataTableColumnHelper, DataTable, useLocale } from '@ptbk/ui';
import type { ColumnVisibilityState, DataTableColumnDef } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useCursorPages } from '../../app/cursor-pages';
import { useDebouncedSearch } from '../../app/debounced-search';
import { useEngineApi } from '../../app/engine-api-context';
import { isInvalidCursor } from '../../app/list-errors';
import { SoftBreaks } from '../../app/soft-breaks';
import { m } from '../../paraglide/messages';
import { memberListQueryOptions } from '../members/members-queries';
import { usePermissions } from '../session/use-permissions';
import { Page } from '../shell/page';
import { useMediaQuery } from '../shell/use-media-query';
import { AuditChainStatus } from './audit-chain-status';
import { AuditEntryDetails } from './audit-entry-details';
import { AuditFilters, TARGET_ID_PATTERN } from './audit-filters';
import { auditKeys } from './audit-keys';
import { AUDIT_OUTCOME_LABELS, AUDIT_OUTCOME_TONES, auditActionLabel, auditTargetKindLabel } from './audit-labels';
import { auditLogQueryOptions, useAuditLog } from './audit-queries';
import { auditListParams, hasAuditFilters } from './audit-search';
import type { AuditSearch } from './audit-search';

const route = getRouteApi('/audit');

/** Below this width the client IP and device start hidden; the reader can still show them from the columns menu. */
export const COMPACT_QUERY = '(max-width: 1023.98px)';
const COMPACT_HIDDEN: ColumnVisibilityState = { clientIp: false, device: false };
const NO_ENTRIES: readonly ReadAuditEntry[] = [];
const NO_MEMBERS: readonly Member[] = [];
// The first page of members names the actors; beyond it an actor falls back to its ID.
const MEMBER_NAME_LIMIT = 100;

interface EntryTimeFormat {
    readonly absolute: Intl.DateTimeFormat;
}

function useEntryTimeFormat(): EntryTimeFormat {
    const { locale } = useLocale();
    return useMemo(
        () => ({
            absolute: new Intl.DateTimeFormat(locale, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                timeZoneName: 'short',
            }),
        }),
        [locale],
    );
}

/** Local time with its zone; the relative time ("3 minutes ago") shows on hover. */
function EntryTime({ at, format }: { readonly at: string; readonly format: EntryTimeFormat }) {
    const locale = useLocale();
    const value = new Date(at);
    return (
        <time dateTime={at} title={locale.formatRelativeTime(value, new Date())} className="whitespace-nowrap">
            {format.absolute.format(value)}
        </time>
    );
}

function actorName(entry: ReadAuditEntry, names: ReadonlyMap<string, string>): string {
    switch (entry.actor.kind) {
        case 'system':
            return m.audit_actor_system();
        case 'member':
            return names.get(entry.actor.memberId) ?? entry.actor.memberId;
        case 'api-token':
            return m.audit_actor_api_token({ name: names.get(entry.actor.memberId) ?? entry.actor.memberId });
    }
}

/** Target names are whatever a member typed; React renders them as text, never as markup. */
function Target({ target }: { readonly target: ReadAuditEntry['target'] }) {
    if (target === null) return <span className="text-text-muted">{m.audit_not_recorded()}</span>;
    return (
        <span className="flex min-w-0 flex-col">
            <span className="text-xs text-text-muted">{auditTargetKindLabel(target.kind)}</span>
            <span className="break-words">{target.name ?? target.id}</span>
            {target.name === null || target.name === undefined ? null : (
                <span className="font-mono text-xs break-words text-text-muted">{target.id}</span>
            )}
        </span>
    );
}

function useAuditColumns(names: ReadonlyMap<string, string>): DataTableColumnDef<ReadAuditEntry>[] {
    const format = useEntryTimeFormat();
    return useMemo(() => {
        const column = createDataTableColumnHelper<ReadAuditEntry>();
        return [
            column.accessor('at', {
                header: m.audit_column_time(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 0 },
                cell: ({ row }) => <EntryTime at={row.original.at} format={format} />,
            }),
            // The name comes from the cell, not the accessor, which TanStack Table caches per row.
            column.accessor((entry) => entry.actor.kind, {
                id: 'actor',
                header: m.audit_column_actor(),
                enableSorting: false,
                meta: { priority: 2 },
                cell: ({ row }) => <span className="break-words">{actorName(row.original, names)}</span>,
            }),
            column.accessor('action', {
                header: m.audit_column_action(),
                enableSorting: false,
                enableHiding: false,
                meta: { priority: 1 },
                cell: ({ row }) => auditActionLabel(row.original.action),
            }),
            column.accessor((entry) => entry.target?.id ?? '', {
                id: 'target',
                header: m.audit_column_target(),
                enableSorting: false,
                meta: { priority: 4 },
                cell: ({ row }) => <Target target={row.original.target} />,
            }),
            column.accessor('outcome', {
                header: m.audit_column_outcome(),
                enableSorting: false,
                meta: { priority: 3 },
                cell: ({ row }) => (
                    <Badge tone={AUDIT_OUTCOME_TONES[row.original.outcome]}>
                        {AUDIT_OUTCOME_LABELS[row.original.outcome]()}
                    </Badge>
                ),
            }),
            column.accessor((entry) => entry.client?.ip ?? '', {
                id: 'clientIp',
                header: m.audit_column_ip(),
                enableSorting: false,
                meta: { priority: 5 },
                cell: ({ row }) =>
                    row.original.client === null ? (
                        <span className="text-text-muted">{m.audit_not_recorded()}</span>
                    ) : (
                        // An IPv4 address never wraps; a long IPv6 one only between its groups.
                        <span className="font-mono text-xs">
                            <SoftBreaks text={row.original.client.ip} after=":" />
                        </span>
                    ),
            }),
            column.accessor((entry) => entry.client?.userAgent ?? '', {
                id: 'device',
                header: m.audit_column_device(),
                enableSorting: false,
                meta: { priority: 6 },
                cell: ({ row }) =>
                    row.original.client === null ? (
                        <span className="text-text-muted">{m.audit_not_recorded()}</span>
                    ) : (
                        <span className="line-clamp-2 text-xs break-words" title={row.original.client.userAgent}>
                            {row.original.client.userAgent}
                        </span>
                    ),
            }),
        ];
    }, [names, format]);
}

function useMemberNames(): { readonly members: readonly Member[]; readonly names: ReadonlyMap<string, string> } {
    const { can } = usePermissions();
    const list = useQuery({
        ...memberListQueryOptions(useEngineApi(), { limit: MEMBER_NAME_LIMIT }),
        enabled: can('members.read'),
    });
    const members = list.data?.items ?? NO_MEMBERS;
    const names = useMemo(() => new Map(members.map((member) => [member.id, member.displayName])), [members]);
    return { members, names };
}

function localTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Read-only: nothing in the UI can alter or delete an entry, and the page only changes on "Refresh". */
export function AuditPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const params = auditListParams(search);
    const list = useAuditLog(params);
    const { members, names } = useMemberNames();
    const columns = useAuditColumns(names);
    const format = useEntryTimeFormat();
    const compact = useMediaQuery(COMPACT_QUERY);
    const [chosenVisibility, setChosenVisibility] = useState<ColumnVisibilityState | null>(null);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    const update = (change: Partial<AuditSearch>, replace = false) => {
        setExpanded({});
        void navigate({ search: (previous) => ({ ...previous, cursor: undefined, ...change }), replace });
    };
    const [targetIdText, setTargetIdText] = useDebouncedSearch(search.targetId, (targetId) => {
        if (targetId === undefined || TARGET_ID_PATTERN.test(targetId)) update({ targetId }, true);
    });
    const paging = useCursorPages(search.cursor, list.data?.nextCursor ?? null, (cursor) => {
        setExpanded({});
        void navigate({ search: (previous) => ({ ...previous, cursor }) });
    });
    const invalidCursor = list.isError && isInvalidCursor(list.error);
    useEffect(() => {
        if (invalidCursor) void navigate({ search: (previous) => ({ ...previous, cursor: undefined }), replace: true });
    }, [invalidCursor, navigate]);

    const filtered = hasAuditFilters(search);
    const clear = () => {
        setTargetIdText('');
        update({
            memberId: undefined,
            action: undefined,
            targetKind: undefined,
            targetId: undefined,
            outcome: undefined,
            from: undefined,
            to: undefined,
        });
    };
    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: auditKeys.all });
    };
    const clearButton = <Button onClick={clear}>{m.audit_clear_filters()}</Button>;

    return (
        <Page
            title={m.audit_title()}
            actions={
                <Button loading={list.isFetching && !list.isPending} onClick={refresh}>
                    <RefreshCw aria-hidden className="size-4" />
                    {m.audit_refresh()}
                </Button>
            }
        >
            <p className="text-sm text-text-muted">{m.audit_intro()}</p>
            <AuditChainStatus />
            <AuditFilters
                search={search}
                members={members}
                onChange={(change) => {
                    update(change);
                }}
                targetIdText={targetIdText}
                onTargetIdTextChange={setTargetIdText}
                onClear={clear}
                filtered={filtered}
                timeZone={localTimeZone()}
            />
            <DataTable
                caption={m.audit_title()}
                columns={columns}
                data={list.data?.items ?? NO_ENTRIES}
                getRowId={(entry) => entry.id}
                getRowLabel={(entry) =>
                    m.audit_entry_label({
                        action: auditActionLabel(entry.action),
                        time: format.absolute.format(new Date(entry.at)),
                    })
                }
                columnVisibility={chosenVisibility ?? (compact ? COMPACT_HIDDEN : {})}
                onColumnVisibilityChange={setChosenVisibility}
                expansion={{
                    expanded,
                    onExpandedChange: setExpanded,
                    renderExpanded: (entry) => <AuditEntryDetails entry={entry} />,
                }}
                page={paging.page}
                onPageChange={paging.onPageChange}
                onPageIntent={(cursor, direction) => {
                    if (direction !== 'next') return;
                    queryClient.query(auditLogQueryOptions(engineApi, { ...params, cursor })).catch(() => undefined);
                }}
                loading={list.isPending}
                fetching={list.isFetching && !list.isPending}
                {...(list.isError && !invalidCursor
                    ? {
                          error: {
                              message: m.audit_load_failed(),
                              onRetry: () => {
                                  void list.refetch();
                              },
                              retrying: list.isFetching,
                          },
                      }
                    : {})}
                empty={
                    filtered
                        ? { title: m.audit_no_results(), description: m.audit_no_results_hint(), action: clearButton }
                        : { title: m.audit_empty_title(), description: m.audit_empty_body() }
                }
            />
        </Page>
    );
}
