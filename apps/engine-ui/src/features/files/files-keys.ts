import type { FileId, FileListQuery, FilePurpose, FileStatsQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type FileListParams = z.input<typeof FileListQuery>;
export type FileStatsParams = z.input<typeof FileStatsQuery>;

/** Every file query lives under `files`, so a reconnect of the event stream can refresh them all at once. */
export const fileKeys = {
    all: ['files'] as const,
    lists: () => [...fileKeys.all, 'list'] as const,
    list: (params: FileListParams) => [...fileKeys.lists(), params] as const,
    stats: () => [...fileKeys.all, 'stats'] as const,
    stat: (params: FileStatsParams) => [...fileKeys.stats(), params] as const,
    details: () => [...fileKeys.all, 'detail'] as const,
    detail: (fileId: FileId) => [...fileKeys.details(), fileId] as const,
    versions: (fileId: FileId) => [...fileKeys.all, 'versions', fileId] as const,
    uploadPolicy: (purpose: FilePurpose) => [...fileKeys.all, 'upload-policy', purpose] as const,
};
