import { z } from 'zod';

import {
    AgentId,
    ChatId,
    FileId,
    FileVersionId,
    MemberId,
    PageQuery,
    RunId,
    Sha256Hex,
    Timestamp,
    pageOf,
} from '../common';
import { defineRoute } from '../route';
import { KNOWN_CAPABILITIES } from './capability';

export const FileName = z.string().trim().min(1).max(255);

/** Why a file exists: agent knowledge, a chat attachment, something a run produced, or a plain upload. */
export const FILE_PURPOSES = ['knowledge', 'attachment', 'output', 'upload'] as const;
export const FilePurpose = z.enum(FILE_PURPOSES);
export type FilePurpose = z.infer<typeof FilePurpose>;

export const FILE_SCAN_STATUSES = ['pending', 'clean', 'infected', 'failed'] as const;
export const FileScanStatus = z.enum(FILE_SCAN_STATUSES);
export type FileScanStatus = z.infer<typeof FileScanStatus>;

export const FileScan = z.strictObject({ status: FileScanStatus, checkedAt: Timestamp.nullable() });

/** A git commit hash, SHA-1 or SHA-256. */
export const CommitHash = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

export const FileMetadata = z.strictObject({
    id: FileId,
    name: FileName,
    contentType: z.string().min(1).max(255),
    sizeBytes: z.int().min(0),
    sha256: Sha256Hex,
    purpose: FilePurpose,
    /** `null` for engine-wide files. */
    agentId: AgentId.nullable(),
    chatId: ChatId.nullable(),
    /** The run that produced an `output` file. */
    runId: RunId.nullable(),
    scan: FileScan,
    versionCount: z.int().min(1),
    createdBy: MemberId,
    createdAt: Timestamp,
});
export type FileMetadata = z.infer<typeof FileMetadata>;
export const FilePage = pageOf(FileMetadata);

/** Agent project files are git-backed, so a version there is a commit. */
export const FileVersion = z.strictObject({
    id: FileVersionId,
    createdAt: Timestamp,
    sizeBytes: z.int().min(0),
    sha256: Sha256Hex,
    commitHash: CommitHash.nullable(),
    runId: RunId.nullable(),
});
export type FileVersion = z.infer<typeof FileVersion>;
export const FileVersionPage = pageOf(FileVersion);

export const FILE_SORTS = ['createdAt', '-createdAt', 'name', '-name', 'sizeBytes', '-sizeBytes'] as const;

export const FileListQuery = PageQuery.extend({
    agentId: AgentId.optional(),
    purpose: FilePurpose.optional(),
    scan: FileScanStatus.optional(),
    /** Matches the name, case-insensitively. */
    q: z.string().min(1).max(255).optional(),
    sort: z.enum(FILE_SORTS).default('-createdAt'),
});

export const FileParams = z.strictObject({ fileId: FileId });
export const FileContentQuery = z.strictObject({ version: FileVersionId.optional() });

/** `multipart/form-data` with `file`, `name`, `purpose` and an optional `agentId`; larger than `MAX_FILE_BYTES` is 413. */
export const UploadFileBody = z.strictObject({
    file: z.instanceof(Blob),
    name: FileName,
    purpose: FilePurpose,
    agentId: AgentId.optional(),
});

export const FileChangedEvent = z.strictObject({
    type: z.literal('file.changed'),
    fileId: FileId,
    agentId: AgentId.nullable(),
});

const capability = KNOWN_CAPABILITIES.files;

export const FILE_ROUTES = {
    listFiles: defineRoute({
        id: 'listFiles',
        method: 'GET',
        path: '/files',
        summary: 'List files, newest first by default',
        permission: 'files.read',
        capability,
        query: FileListQuery,
        responses: { 200: { kind: 'json', schema: FilePage } },
    }),
    uploadFile: defineRoute({
        id: 'uploadFile',
        method: 'POST',
        path: '/files',
        summary: 'Upload a file',
        permission: 'files.write',
        capability,
        body: { kind: 'multipart', schema: UploadFileBody },
        responses: { 201: { kind: 'json', schema: FileMetadata } },
        problems: ['payload-too-large', 'unsupported-media-type'],
    }),
    getFile: defineRoute({
        id: 'getFile',
        method: 'GET',
        path: '/files/{fileId}',
        summary: "Get a file's metadata",
        permission: 'files.read',
        capability,
        params: FileParams,
        responses: { 200: { kind: 'json', schema: FileMetadata } },
    }),
    listFileVersions: defineRoute({
        id: 'listFileVersions',
        method: 'GET',
        path: '/files/{fileId}/versions',
        summary: "List a file's versions, newest first",
        permission: 'files.read',
        capability,
        params: FileParams,
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: FileVersionPage } },
    }),
    downloadFile: defineRoute({
        id: 'downloadFile',
        method: 'GET',
        path: '/files/{fileId}/content',
        summary: "Download a file's bytes, or one version's with `?version=`",
        description:
            'Always sent as an attachment with `X-Content-Type-Options: nosniff`. A file whose scan found malware is never served: 409 `file-infected`.',
        permission: 'files.read',
        capability,
        params: FileParams,
        query: FileContentQuery,
        responses: { 200: { kind: 'binary' } },
        problems: ['file-infected'],
    }),
    deleteFile: defineRoute({
        id: 'deleteFile',
        method: 'DELETE',
        path: '/files/{fileId}',
        summary: 'Delete a file with all its versions',
        permission: 'files.write',
        capability,
        params: FileParams,
        responses: { 204: { kind: 'empty' } },
    }),
} as const;
