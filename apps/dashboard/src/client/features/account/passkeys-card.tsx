import {
    Button,
    ConfirmDialog,
    createDataTableColumnHelper,
    DataTable,
    RelativeTime,
    Section,
    StatusPill,
} from '@ptbk/ui';
import { useLocale as useFormatters } from '@ptbk/ui';
import type { DataTableColumnDef } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes } from '../../../shared/api/routes';
import type { PasskeyView } from '../../../shared/api/routes';
import { dataOrThrow, passkeysQuery, problemCode, queryKeys } from '../../api/queries';
import { useApiClient } from '../../api/api-client-context';
import { useBrowser } from '../../core/browser';
import { useAppMutation } from '../../core/mutations';
import { addPasskey, CeremonyError, valueOrThrow } from '../passkeys/ceremonies';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';
import { passkeyAddedVia, passkeyLabel, passkeyName, passkeyOrigin } from './passkey-labels';

const columns = createDataTableColumnHelper<PasskeyView>();
/** Answers that are about the ceremony itself; the rest (step-up, cooldown, rate limit…) get the common handling. */
const CEREMONY_CODES: ReadonlySet<string> = new Set(['challenge-invalid', 'webauthn-failed', 'conflict']);

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
        errorMessage: (error) => {
            if (error instanceof CeremonyError) {
                return ceremonyFailureMessage({ kind: 'passkey', reason: error.reason }, 'register');
            }
            const code = problemCode(error);
            return code !== null && CEREMONY_CODES.has(code)
                ? ceremonyFailureMessage({ kind: 'api', code }, 'register')
                : undefined;
        },
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

    const label = useCallback(
        (passkey: PasskeyView) => passkeyLabel(passkey, (date) => formatters.formatDate(date)),
        [formatters],
    );
    const rows = passkeys.data;
    const onlyOne = rows !== undefined && rows.length <= 1;
    const tableColumns = useMemo(
        (): DataTableColumnDef<PasskeyView>[] => [
            columns.accessor('credentialId', {
                header: m.passkey_column_name(),
                cell: (context) => {
                    const passkey = context.row.original;
                    return (
                        <span className="flex flex-col gap-0.5">
                            <span className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{passkeyName(passkey)}</span>
                                {passkey.counterRegressedAt === null ? null : (
                                    <StatusPill tone="danger">{m.passkey_flagged()}</StatusPill>
                                )}
                            </span>
                            <span className="text-xs text-text-muted tabular-nums">
                                {m.passkey_created_on({ date: formatters.formatDate(new Date(passkey.createdAt)) })}
                                <span aria-hidden="true"> · </span>
                                {passkey.lastUsedAt === null ? (
                                    m.passkey_never_used()
                                ) : (
                                    <>
                                        {m.passkey_last_used()}{' '}
                                        <RelativeTime value={new Date(passkey.lastUsedAt)} now={now} />
                                    </>
                                )}
                            </span>
                        </span>
                    );
                },
                meta: { priority: 0 },
            }),
            columns.accessor('backedUp', {
                header: m.passkey_column_origin(),
                cell: (context) => passkeyOrigin(context.row.original),
                meta: { priority: 1 },
            }),
            columns.accessor('addedVia', {
                header: m.passkey_column_added_via(),
                cell: (context) => passkeyAddedVia(context.row.original),
                meta: { priority: 2 },
            }),
            columns.display({
                id: 'remove',
                header: () => <span className="sr-only">{m.passkey_column_actions()}</span>,
                cell: (context) => (
                    <Button
                        size="sm"
                        variant="danger-ghost"
                        disabled={onlyOne}
                        {...(onlyOne ? { disabledReason: m.passkey_remove_last() } : {})}
                        aria-label={m.passkey_remove_named({ name: label(context.row.original) })}
                        onClick={() => {
                            setRemoving(context.row.original);
                        }}
                    >
                        {m.passkey_remove()}
                    </Button>
                ),
                meta: { label: m.passkey_column_actions(), priority: 3 },
            }),
        ],
        [formatters, now, onlyOne, label],
    );

    return (
        <Section
            title={m.passkeys_title()}
            description={m.passkeys_body()}
            actions={
                <Button
                    variant="primary"
                    size="sm"
                    loading={add.isPending}
                    onClick={() => {
                        add.mutate();
                    }}
                >
                    <Plus aria-hidden className="size-4" />
                    {m.passkey_add()}
                </Button>
            }
        >
            <DataTable<PasskeyView>
                caption={m.passkeys_title()}
                mode="client"
                columns={tableColumns}
                data={rows ?? []}
                getRowId={(row) => row.credentialId}
                getRowLabel={label}
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
                description={m.passkey_remove_body({ name: removing === null ? '' : label(removing) })}
                confirmLabel={m.passkey_remove()}
                tone="danger"
                loading={remove.isPending}
            />
        </Section>
    );
}
