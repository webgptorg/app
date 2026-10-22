import type { EngineApiClient, FileId, FilePurpose } from '@ptbk/engine-api';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { fileKeys } from './files-keys';
import type { FileListParams, FileStatsParams } from './files-keys';

/** Versions of one file the drawer lists; a file with more shows the newest this many. */
export const FILE_VERSION_LIMIT = 50;

/** `GET /files`: filters, sort and paging all happen on the engine. */
export function fileListQueryOptions(engineApi: EngineApiClient, params: FileListParams) {
    return queryOptions({
        queryKey: fileKeys.list(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.files.list(params, signal)),
    });
}

export function fileStatsQueryOptions(engineApi: EngineApiClient, params: FileStatsParams) {
    return queryOptions({
        queryKey: fileKeys.stat(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.files.stats(params, signal)),
    });
}

export function fileDetailQueryOptions(engineApi: EngineApiClient, fileId: FileId) {
    return queryOptions({
        queryKey: fileKeys.detail(fileId),
        queryFn: async ({ signal }) => unwrap(await engineApi.files.get(fileId, signal)),
    });
}

export function fileVersionsQueryOptions(engineApi: EngineApiClient, fileId: FileId) {
    return queryOptions({
        queryKey: fileKeys.versions(fileId),
        queryFn: async ({ signal }) =>
            unwrap(await engineApi.files.listVersions(fileId, { limit: FILE_VERSION_LIMIT }, signal)),
    });
}

/** The engine's limits for one purpose; they change only with the engine's configuration. */
export function uploadPolicyQueryOptions(engineApi: EngineApiClient, purpose: FilePurpose) {
    return queryOptions({
        queryKey: fileKeys.uploadPolicy(purpose),
        queryFn: async ({ signal }) => unwrap(await engineApi.files.uploadPolicy({ purpose }, signal)),
        staleTime: 10 * 60_000,
    });
}

/** One page of files; the previous page stays on screen while the next one loads. */
export function useFiles(filters: FileListParams) {
    return useQuery({
        ...fileListQueryOptions(useEngineApi(), filters),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevelFailure,
    });
}

export function useFile(fileId: FileId) {
    return useQuery(fileDetailQueryOptions(useEngineApi(), fileId));
}

export function useFileVersions(fileId: FileId) {
    return useQuery(fileVersionsQueryOptions(useEngineApi(), fileId));
}

export function useFileStats(params: FileStatsParams) {
    return useQuery(fileStatsQueryOptions(useEngineApi(), params));
}

export function useUploadPolicy(purpose: FilePurpose) {
    return useQuery(uploadPolicyQueryOptions(useEngineApi(), purpose));
}
