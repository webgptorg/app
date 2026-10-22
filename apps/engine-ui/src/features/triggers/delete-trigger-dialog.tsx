import type { ReadTrigger } from '@ptbk/engine-api';
import { ConfirmDialog } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { useTriggerMutations } from './use-trigger-mutations';

/** Names the trigger and waits for the engine; runs it started are kept (C-07). */
export function DeleteTriggerDialog({
    trigger,
    onClose,
    onDeleted,
}: {
    readonly trigger: Pick<ReadTrigger, 'id' | 'name'>;
    readonly onClose: () => void;
    readonly onDeleted?: () => void;
}) {
    const { remove } = useTriggerMutations();
    return (
        <ConfirmDialog
            open
            onClose={onClose}
            onConfirm={async () => {
                try {
                    await remove.mutateAsync({ id: trigger.id, name: trigger.name });
                    onClose();
                    onDeleted?.();
                } catch {
                    // The mutation reported it in a toast; the dialog stays open for another try.
                }
            }}
            title={m.trigger_delete_title({ name: trigger.name })}
            description={m.trigger_delete_body()}
            confirmLabel={m.trigger_delete()}
            tone="danger"
            loading={remove.isPending}
        />
    );
}
