import { Button, Card, ConfirmDialog } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type EngineView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, queryKeys } from '../../api/queries';
import { useAppMutation } from '../../core/mutations';
import { shortEngineId } from './engine-labels';

/**
 * "Revoke engine" (D-06): permanent, so the dialog spells out what recovery takes and asks for the engine ID's first
 * characters before anything is sent. The API may ask for a step-up first; `useAppMutation` runs it in place.
 */
export function RevokeEngineCard(props: { readonly engine: EngineView }) {
    const api = useApiClient();
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const { engineId } = props.engine;
    const shortId = shortEngineId(engineId);
    const revoke = useAppMutation({
        mutationFn: async () => dataOrThrow(await api.call(apiRoutes.revokeEngine, { params: { engineId } })).engine,
        invalidates: [queryKeys.engines],
        successMessage: () => m.engine_revoked(),
        onSuccess: (engine) => {
            queryClient.setQueryData(queryKeys.engine(engineId), engine);
            setOpen(false);
        },
    });
    return (
        <Card title={m.engine_revoke_title()}>
            <div className="flex flex-col items-start gap-3">
                <p className="text-sm">{m.engine_revoke_body()}</p>
                <Button
                    variant="danger"
                    onClick={() => {
                        setOpen(true);
                    }}
                >
                    {m.engine_revoke_button()}
                </Button>
            </div>
            <ConfirmDialog
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                onConfirm={() => {
                    revoke.mutate();
                }}
                title={m.engine_revoke_dialog_title({ shortId })}
                description={m.engine_revoke_dialog_body()}
                confirmLabel={m.engine_revoke_confirm()}
                tone="danger"
                confirmPhrase={shortId}
                loading={revoke.isPending}
            />
        </Card>
    );
}
