import { Badge, Button, Card, ConfirmDialog, createDataTableColumnHelper, DataTable, RelativeTime } from '@ptbk/ui';
import { useLocale as useFormatters } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import type { PasskeyView } from '../../../shared/api/routes';
import { dataOrThrow, passkeysQuery, problemCode, queryKeys } from '../../api/queries';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { useAppMutation } from '../../core/mutations';
import { addPasskey, CeremonyError, valueOrThrow } from '../passkeys/ceremonies';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';
import { passkeyName, passkeyOrigin, passkeyAddedVia } from './passkey-labels';

const columns = createDataTableColumnHelper<PasskeyView>();

/** Passkeys of the account: add one, remove any but the last. Neither is optimistic (D-09 brief). */
export function PasskeysCard() {
    const api = useApiClient();
    const browser = useBrowser();
    const formatters = useFormatters();
    const passkeys = useQuery(passkeysQuery(api));
    const [removing, setRemoving] = useState<PasskeyView | null>(null);
    const [now] = useState(() => new Date(browser.now()));

    const add = useAppMutation({
        mutationFn: async () => valueOrThrow(await addPasskey({ api, passkeys: browser.passkeys })),
        invalidates: [queryKeys.passkeys],
        successMessage: () => m.passkey_added(),
        errorMessage: (error) =>
            error instanceof CeremonyError ? ceremonyFailureMessage(error.failure, 'register') : undefined,
    });
    const remove = useAppMutation({
        mutationFn: async (passkey: PasskeyView) =>
            dataOrThrow(await api.call(apiRoutes.passkeyDelete, { body: { credentialId: passkey.credentialId } })),
        invalidates: [queryKeys.passkeys],
        successMessage: () => m.passkey_removed(),
        errorMessage: (error) => (problemCode(error) === 'last-passkey' ? m.passkey_remove_last() : undefined),
        onSuccess: () => {
            setRemoving(null);
        },
    });

    const rows = passkeys.data;
    const onlyOne = rows !== undefined && rows.length <= 1;
    const tableColumns = useMemo(
        (): DataTableColumnDef<PasskeyView>[] => [
            columns.accessor('credentialId', {
                header: m.passkey_column_name(),
                cell: (context) => (
                    <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{passkeyName(context.row.original)}</span>
                        {context.row.original.counterRegressedAt === null ? null : (
                            <Badge tone="danger">{m.passkey_flagged()}</Badge>
                        )}
                    </span>
                ),
                meta: { priority: 0 },
            }),
            columns.accessor('backedUp', {
                header: m.passkey_column_origin(),
                cell: (context) => passkeyOrigin(context.row.original),
                meta: { priority: 1 },
            }),
            columns.accessor('createdAt', {
                header: m.passkey_column_created(),
                cell: (context) => formatters.formatDate(new Date(context.row.original.createdAt)),
                meta: { priority: 2 },
            }),
            columns.accessor('lastUsedAt', {
                header: m.passkey_column_last_used(),
                cell: (context) => {
                    const lastUsedAt = context.row.original.lastUsedAt;
                    return lastUsedAt === null ? (
                        m.passkey_never_used()
                    ) : (
                        <RelativeTime value={new Date(lastUsedAt)} now={now} />
                    );
                },
                meta: { priority: 3 },
            }),
            columns.accessor('addedVia', {
                header: m.passkey_column_added_via(),
                cell: (context) => passkeyAddedVia(context.row.original),
                meta: { priority: 4 },
            }),
            columns.display({
                id: 'remove',
                header: () => <span className="sr-only">{m.passkey_column_actions()}</span>,
                cell: (context) => (
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={onlyOne}
                        {...(onlyOne ? { disabledReason: m.passkey_remove_last() } : {})}
                        aria-label={m.passkey_remove_named({ name: passkeyName(context.row.original) })}
                        onClick={() => {
                            setRemoving(context.row.original);
                        }}
                    >
                        {m.passkey_remove()}
                    </Button>
                ),
                meta: { label: m.passkey_column_actions(), priority: 5 },
            }),
        ],
        [formatters, now, onlyOne],
    );

    return (
        <Card
            title={m.passkeys_title()}
            actions={
                <Button
                    variant="primary"
                    size="sm"
                    loading={add.isPending}
                    onClick={() => {
                        add.mutate();
                    }}
                >
                    <Plus aria-hidden className="me-1 size-4" />
                    {m.passkey_add()}
                </Button>
            }
        >
            <p className="text-sm text-text-muted">{m.passkeys_body()}</p>
            <DataTable<PasskeyView>
                caption={m.passkeys_title()}
                mode="client"
                columns={tableColumns}
                data={rows ?? []}
                getRowId={(row) => row.credentialId}
                getRowLabel={passkeyName}
                loading={passkeys.isPending}
                {...(passkeys.isError
                    ? {
                          error: {
                              message: m.passkeys_load_failed(),
                              onRetry: () => void passkeys.refetch(),
                              retrying: passkeys.isFetching,
                          },
                      }
                    : {})}
                skeletonRows={2}
            />
            <ConfirmDialog
                open={removing !== null}
                onClose={() => {
                    setRemoving(null);
                }}
                onConfirm={() => {
                    if (removing !== null) {
                        remove.mutate(removing);
                    }
                }}
                title={m.passkey_remove_title()}
                description={m.passkey_remove_body({ name: removing === null ? '' : passkeyName(removing) })}
                confirmLabel={m.passkey_remove()}
                tone="danger"
                loading={remove.isPending}
            />
        </Card>
    );
}
