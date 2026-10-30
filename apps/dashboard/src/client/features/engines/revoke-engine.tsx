import { Button, Card, ConfirmDialog } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type EngineView } from '../../../shared/api/routes';
import { engineLabel, shortEngineId } from '../../../shared/engine-label';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, queryKeys } from '../../api/queries';
import { useAppMutation } from '../../core/mutations';
import { ceremonyFailureMessage } from '../passkeys/ceremony-messages';
import { StepUpFailedError, useStepUp } from '../step-up/step-up';

/**
 * "Revoke engine" (D-06): permanent, so the dialog says what that means and asks for the engine ID's first characters
 * before anything is sent. The passkey check revoking needs runs from the dialog's own button, so a second modal never
 * opens on top of it; its failure shows in the dialog, which stays open for another try.
 */
export function RevokeEngineCard(props: { readonly engine: EngineView }) {
    const api = useApiClient();
    const queryClient = useQueryClient();
    const { needsStepUp, stepUpInPlace } = useStepUp();
    const [open, setOpen] = useState(false);
    const { engineId } = props.engine;
    const shortId = shortEngineId(engineId);
    const revoke = useAppMutation({
        stepUp: 'in-place',
        mutationFn: async () => {
            if (needsStepUp()) {
                await stepUpInPlace();
            }
            return dataOrThrow(await api.call(apiRoutes.revokeEngine, { params: { engineId } })).engine;
        },
        invalidates: [queryKeys.engines],
        successMessage: () => m.engine_revoked(),
        onSuccess: (engine) => {
            queryClient.setQueryData(queryKeys.engine(engineId), engine);
            setOpen(false);
        },
    });
    const close = () => {
        setOpen(false);
        revoke.reset();
    };
    const failure = revoke.error instanceof StepUpFailedError ? revoke.error.failure : null;
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
                onClose={close}
                onConfirm={() => {
                    revoke.mutate();
                }}
                title={m.engine_revoke_dialog_title({ name: engineLabel(props.engine) })}
                description={m.engine_revoke_dialog_body()}
                confirmLabel={needsStepUp() ? m.engine_revoke_confirm_passkey() : m.engine_revoke_confirm()}
                tone="danger"
                confirmPhrase={shortId}
                loading={revoke.isPending}
                {...(failure === null ? {} : { error: ceremonyFailureMessage(failure, 'authenticate') })}
            >
                <ul className="list-disc ps-5 text-sm">
                    <li>{m.engine_revoke_dialog_address()}</li>
                    <li>{m.engine_revoke_dialog_recover()}</li>
                </ul>
            </ConfirmDialog>
        </Card>
    );
}
