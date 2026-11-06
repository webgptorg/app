import { ActionMenu, Card, ConfirmDialog, useLocale } from '@ptbk/ui';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type PendingLinkCodesView } from '../../../shared/api/routes';
import type { ApiClient } from '../../api/api-client';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow } from '../../api/queries';
import { useAppMutation } from '../../core/mutations';

type PendingLinkCode = PendingLinkCodesView['linkCodes'][number];

const PENDING_LINK_CODES_KEY = ['pending-link-codes'] as const;

export function pendingLinkCodesQuery(client: ApiClient) {
    return queryOptions({
        queryKey: PENDING_LINK_CODES_KEY,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.listLinkCodes, {}, signal)).linkCodes,
    });
}

function PendingLinkCodeRow(props: { readonly code: PendingLinkCode }) {
    const api = useApiClient();
    const locale = useLocale();
    const [open, setOpen] = useState(false);
    const { linkCodeId } = props.code;
    const created = locale.formatDateTime(new Date(props.code.createdAt));
    const revoke = useAppMutation({
        mutationFn: async () => {
            dataOrThrow(await api.call(apiRoutes.cancelLinkCode, { params: { linkCodeId } }));
        },
        invalidates: [PENDING_LINK_CODES_KEY],
        successMessage: () => m.link_codes_revoked(),
        onSuccess: () => {
            setOpen(false);
        },
    });
    return (
        <li className="flex items-center gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                <span>{m.link_codes_created({ created })}</span>
                <span className="text-text-muted">
                    {m.link_codes_until({ until: locale.formatDateTime(new Date(props.code.expiresAt)) })}
                </span>
            </div>
            <ActionMenu
                label={m.link_codes_actions({ created })}
                items={[
                    {
                        kind: 'item',
                        id: 'revoke',
                        label: m.link_codes_revoke(),
                        tone: 'danger',
                        onSelect: () => {
                            setOpen(true);
                        },
                    },
                ]}
            />
            <ConfirmDialog
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                onConfirm={() => {
                    revoke.mutate();
                }}
                title={m.link_codes_revoke_title()}
                description={m.link_codes_revoke_body()}
                confirmLabel={m.link_codes_revoke()}
                tone="danger"
                loading={revoke.isPending}
            />
        </li>
    );
}

/**
 * Codes live for weeks, so an owner sees the ones still waiting for an engine and can end any that leaked or are no
 * longer needed. Nothing shows while there are none, or while they load or fail to: this is a side note on the page.
 */
export function PendingLinkCodes() {
    const api = useApiClient();
    const codes = useQuery(pendingLinkCodesQuery(api));
    if (codes.data === undefined || codes.data.length === 0) {
        return null;
    }
    return (
        <Card title={m.link_codes_title()}>
            <p className="text-sm text-text-muted">{m.link_codes_body()}</p>
            <ul className="-mx-5 -mb-5 divide-y divide-divider" aria-label={m.link_codes_title()}>
                {codes.data.map((code) => (
                    <PendingLinkCodeRow key={code.linkCodeId} code={code} />
                ))}
            </ul>
        </Card>
    );
}
