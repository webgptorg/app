import type { FileId } from '@ptbk/engine-api';
import { useQueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { fileKeys } from './files-keys';

/**
 * Keeps file data current from the engine's event stream, so nothing polls: a `file.changed` hint and any `file.*`
 * activity refetch that file, its versions, the lists and the counts that are on screen (the rest are only marked
 * stale). A reconnect refetches everything once, since events in the gap may be gone.
 */
export function useFileEventSync(): void {
    const queryClient = useQueryClient();
    const refresh = (fileId: FileId) => {
        void queryClient.invalidateQueries({ queryKey: fileKeys.detail(fileId) });
        void queryClient.invalidateQueries({ queryKey: fileKeys.versions(fileId) });
        void queryClient.invalidateQueries({ queryKey: fileKeys.lists() });
        void queryClient.invalidateQueries({ queryKey: fileKeys.stats() });
    };
    useEngineEvents({
        onEvent: (event) => {
            if (event.type === 'file.changed') refresh(event.fileId);
            else if (
                event.type === 'activity' &&
                event.activity.kind === 'known' &&
                (event.activity.activity.kind === 'file.created' ||
                    event.activity.activity.kind === 'file.deleted' ||
                    event.activity.activity.kind === 'file.scan-failed')
            ) {
                refresh(event.activity.activity.fileId);
            }
        },
        onReconnect: () => {
            void queryClient.invalidateQueries({ queryKey: fileKeys.all });
        },
    });
}
