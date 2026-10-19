import { z } from 'zod';

import { FileId, MemberId, PageQuery, Sha256Hex, Timestamp, pageOf } from './common';
import { defineRoute } from './route';

export const FileName = z.string().trim().min(1).max(255);

export const FileMetadata = z.strictObject({
    id: FileId,
    name: FileName,
    contentType: z.string().min(1).max(255),
    sizeBytes: z.int().min(0),
    sha256: Sha256Hex,
    createdBy: MemberId,
    createdAt: Timestamp,
});
export type FileMetadata = z.infer<typeof FileMetadata>;
export const FilePage = pageOf(FileMetadata);

export const FileParams = z.strictObject({ fileId: FileId });

/** `multipart/form-data` with a `file` part and a `name` part; larger than `MAX_FILE_BYTES` is 413. */
export const UploadFileBody = z.strictObject({ file: z.instanceof(Blob), name: FileName });

export const FILE_ROUTES = {
    listFiles: defineRoute({
        id: 'listFiles',
        method: 'GET',
        path: '/files',
        summary: 'List files, newest first',
        permission: 'files.read',
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: FilePage } },
    }),
    uploadFile: defineRoute({
        id: 'uploadFile',
        method: 'POST',
        path: '/files',
        summary: 'Upload a file',
        permission: 'files.write',
        body: { kind: 'multipart', schema: UploadFileBody },
        responses: { 201: { kind: 'json', schema: FileMetadata } },
        problems: ['payload-too-large', 'unsupported-media-type'],
    }),
    downloadFile: defineRoute({
        id: 'downloadFile',
        method: 'GET',
        path: '/files/{fileId}/content',
        summary: "Download a file's bytes, always as an attachment",
        permission: 'files.read',
        params: FileParams,
        responses: { 200: { kind: 'binary' } },
    }),
    deleteFile: defineRoute({
        id: 'deleteFile',
        method: 'DELETE',
        path: '/files/{fileId}',
        summary: 'Delete a file',
        permission: 'files.write',
        params: FileParams,
        responses: { 204: { kind: 'empty' } },
    }),
} as const;
