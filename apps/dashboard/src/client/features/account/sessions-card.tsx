import { Badge, Button, Card, ConfirmDialog, createDataTableColumnHelper, DataTable, RelativeTime } from '@ptbk/ui';
import { useLocale as useFormatters, useToast } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import type { SessionSummary } from '../../../shared/api/routes';
import { dataOrThrow, sessionsQuery } from '../../api/queries';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { useAppMutation } from '../../core/mutations';
import { leaveSignedInArea } from '../session/end-session';

const columns = createDataTableColumnHelper<SessionSummary>();

/** Sessions have no public ID (only the hash of the cookie exists server-side), so rows are keyed by their start. */
function sessionRowId(session: SessionSummary): string {
    return `${String(session.createdAt)}-${session.current ? 'current' : 'other'}`;
}

/** Signed-in sessions of the account, and "sign out everywhere", which also ends this one. Not optimistic. */
export function SessionsCard() {
    const api = useApiClient();
    const browser = useBrowser();
    const formatters = useFormatters();
    const toast = useToast();
    const queryClient = useQueryClient();
    const router = useRouter();
    const sessions = useQuery(sessionsQuery(api));
    const [confirming, setConfirming] = useState(false);
    const [now] = useState(() => new Date(browser.now()));

    const revokeAll = useAppMutation({
        mutationFn: async () => dataOrThrow(await api.call(apiRoutes.revokeAllSessions, {})),
        onSuccess: async () => {
            setConfirming(false);
            toast.show({ tone: 'success', title: m.sessions_revoked() });
            await leaveSignedInArea(queryClient, router);
        },
    });

    const label = (session: SessionSummary) => (session.current ? m.session_current() : m.session_other());
    const tableColumns = useMemo(
        (): DataTableColumnDef<SessionSummary>[] => [
            columns.accessor('current', {
                header: m.session_column_session(),
                cell: (context) =>
                    context.row.original.current ? (
                        <Badge tone="accent">{m.session_current()}</Badge>
                    ) : (
                        m.session_other()
                    ),
                meta: { priority: 0 },
            }),
            columns.accessor('createdAt', {
                header: m.session_column_created(),
                cell: (context) => formatters.formatDateTime(new Date(context.row.original.createdAt)),
                meta: { priority: 1 },
            }),
            columns.accessor('lastSeenAt', {
                header: m.session_column_last_seen(),
                cell: (context) => <RelativeTime value={new Date(context.row.original.lastSeenAt)} now={now} />,
                meta: { priority: 2 },
            }),
            columns.accessor('expiresAt', {
                header: m.session_column_expires(),
                cell: (context) => formatters.formatDate(new Date(context.row.original.expiresAt)),
                meta: { priority: 3 },
            }),
        ],
        [formatters, now],
    );

    return (
        <Card
            title={m.sessions_title()}
            actions={
                <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                        setConfirming(true);
                    }}
                >
                    {m.sessions_revoke_all()}
                </Button>
            }
        >
            <p className="text-sm text-text-muted">{m.sessions_body()}</p>
            <DataTable<SessionSummary>
                caption={m.sessions_title()}
                mode="client"
                columns={tableColumns}
                data={sessions.data ?? []}
                getRowId={sessionRowId}
                getRowLabel={label}
                loading={sessions.isPending}
                {...(sessions.isError
                    ? {
                          error: {
                              message: m.sessions_load_failed(),
                              onRetry: () => void sessions.refetch(),
                              retrying: sessions.isFetching,
                          },
                      }
                    : {})}
                skeletonRows={1}
            />
            <ConfirmDialog
                open={confirming}
                onClose={() => {
                    setConfirming(false);
                }}
                onConfirm={() => {
                    revokeAll.mutate();
                }}
                title={m.sessions_revoke_all_title()}
                description={m.sessions_revoke_all_body()}
                confirmLabel={m.sessions_revoke_all()}
                tone="danger"
                loading={revokeAll.isPending}
            />
        </Card>
    );
}
