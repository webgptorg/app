import { ConfirmDialog } from '@ptbk/ui';
import { useState } from 'react';

import { m } from '../../paraglide/messages';
import { useFileMutations } from './use-file-mutations';
import type { FileTarget } from './use-file-mutations';

/**
 * Delete with confirmation: the dialog names the file and stays open, busy, until the engine answered; the outcome is
 * a toast. `onDeleted` runs only once the engine confirmed it.
 */
export function useFileDelete(onDeleted?: (file: FileTarget) => void) {
    const { remove } = useFileMutations();
    const [target, setTarget] = useState<FileTarget | null>(null);
    const close = () => {
        if (!remove.isPending) setTarget(null);
    };
    const dialog = (
        <ConfirmDialog
            open={target !== null}
            onClose={close}
            title={m.files_delete_title()}
            description={target === null ? '' : m.files_delete_body({ name: target.name })}
            confirmLabel={m.files_delete_confirm()}
            tone="danger"
            loading={remove.isPending}
            onConfirm={async () => {
                if (target === null) return;
                try {
                    await remove.mutateAsync(target);
                    onDeleted?.(target);
                } catch {
                    // The mutation already reported the failure as a toast; the dialog closes either way.
                }
                setTarget(null);
            }}
        />
    );
    return {
        request: (file: FileTarget) => {
            setTarget(file);
        },
        dialog,
    };
}
