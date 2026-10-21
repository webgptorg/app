import type { AgentId, FileId, FilePurpose, UploadProgress } from '@ptbk/engine-api';
import { useQueryClient } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { fileKeys } from './files-keys';

/** Mutations are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const DELETE_TIMEOUT_MS = 30_000;

/** The file a mutation acts on; the name is for messages only. */
export interface FileTarget {
    readonly id: FileId;
    readonly name: string;
}

export interface FileUpload {
    readonly file: File;
    readonly purpose: FilePurpose;
    readonly agentId?: AgentId;
    /** Cancels the upload; the client also stops waiting on it. */
    readonly signal: AbortSignal;
    readonly onProgress: (progress: UploadProgress) => void;
}

/**
 * Every change to files. Delete is not optimistic: the row goes once the engine confirmed it. Upload resolves with the
 * engine's answer, so the caller can show it next to the file it belongs to.
 */
export function useFileMutations() {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: fileKeys.lists() }),
            queryClient.invalidateQueries({ queryKey: fileKeys.stats() }),
        ]);

    const remove = useStepUpAwareMutation({
        mutationFn: async ({ id }: FileTarget) =>
            unwrap(await engineApi.files.delete(id, AbortSignal.timeout(DELETE_TIMEOUT_MS))),
        invalidates: [fileKeys.lists(), fileKeys.stats()],
        successMessage: (_, { name }) => m.files_deleted({ name }),
        errorMessage: (_, { name }) => m.files_delete_failed({ name }),
        onSuccess: (_, { id }) => {
            queryClient.removeQueries({ queryKey: fileKeys.detail(id) });
            queryClient.removeQueries({ queryKey: fileKeys.versions(id) });
        },
    });

    const upload = async ({ file, purpose, agentId, signal, onProgress }: FileUpload) => {
        const response = await engineApi.files.upload(
            { file, name: file.name, purpose, ...(agentId === undefined ? {} : { agentId }) },
            signal,
            { onProgress },
        );
        if (response.kind === 'ok') void refresh();
        return response;
    };

    return { remove, upload };
}
