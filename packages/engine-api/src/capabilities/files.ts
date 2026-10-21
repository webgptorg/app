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
import { MAX_FILE_BYTES } from '../constants';
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

/** One value or a comma-separated set of them, e.g. `infected,failed`; read as the set's values. */
function valueSet<const Values extends readonly [string, ...string[]]>(values: Values) {
    const alternatives = values.join('|');
    return z
        .string()
        .max(128)
        .regex(new RegExp(`^(?:${alternatives})(?:,(?:${alternatives}))*$`))
        .transform((value) => [...new Set(value.split(','))])
        .pipe(z.array(z.enum(values)));
}

export const FileListQuery = PageQuery.extend({
    agentId: AgentId.optional(),
    /** One purpose or a comma-separated set, e.g. `attachment,upload`. */
    purpose: valueSet(FILE_PURPOSES).optional(),
    /** One scan status or a comma-separated set, e.g. `infected,failed`. */
    scan: valueSet(FILE_SCAN_STATUSES).optional(),
    /** Matches the name, case-insensitively. */
    q: z.string().min(1).max(255).optional(),
    sort: z.enum(FILE_SORTS).default('-createdAt'),
});

export const FileStatsQuery = z.strictObject({ agentId: AgentId.optional() });
/** How many files there are, by purpose and by scan status; every known key is always present. */
export const FileStats = z.strictObject({
    byPurpose: z.strictObject({
        knowledge: z.int().min(0),
        attachment: z.int().min(0),
        output: z.int().min(0),
        upload: z.int().min(0),
    }),
    byScan: z.strictObject({
        pending: z.int().min(0),
        clean: z.int().min(0),
        infected: z.int().min(0),
        failed: z.int().min(0),
    }),
});
export type FileStats = z.infer<typeof FileStats>;

/**
 * One entry of an upload policy's `accept` list, in the grammar of HTML's `accept` attribute, lowercase: a file
 * extension (`.pdf`), a media type (`text/plain`) or a media type range (`image/*`).
 */
export const FileAcceptToken = z
    .string()
    .max(128)
    .regex(
        /^(?:\.[a-z0-9][a-z0-9._+-]{0,31}|[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,62}))$/,
    );

export const FileUploadPolicyQuery = z.strictObject({ purpose: FilePurpose });
/**
 * What the engine accepts for one purpose. A larger file is 413 `payload-too-large`; one that matches no `accept` entry
 * is 415 `unsupported-media-type`. An empty `accept` takes any type.
 */
export const FileUploadPolicy = z.strictObject({
    purpose: FilePurpose,
    maxBytes: z.int().min(1).max(MAX_FILE_BYTES),
    accept: z.array(FileAcceptToken).max(64),
});
export type FileUploadPolicy = z.infer<typeof FileUploadPolicy>;

/**
 * Whether a file matches an upload policy's `accept` list, as the engine decides it: by the name's extension or the
 * declared media type (parameters ignored), case-insensitively. Clients check it before uploading; the engine still
 * decides.
 */
export function acceptsFile(
    accept: readonly string[],
    file: { readonly name: string; readonly type: string },
): boolean {
    if (accept.length === 0) return true;
    const name = file.name.toLowerCase();
    const type = file.type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    return accept.some((token) => {
        if (token.startsWith('.')) return name.endsWith(token) && name.length > token.length;
        if (type === '') return false;
        if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
        return type === token;
    });
}

export const FileParams = z.strictObject({ fileId: FileId });
export const FileContentQuery = z.strictObject({ version: FileVersionId.optional() });

/**
 * `multipart/form-data` with `file`, `name`, `purpose` and an optional `agentId`. Larger than the purpose's upload
 * policy allows (at most `MAX_FILE_BYTES`) is 413; a type the policy does not accept is 415.
 */
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
    getFileStats: defineRoute({
        id: 'getFileStats',
        method: 'GET',
        path: '/files/stats',
        summary: 'Count files by purpose and by scan status',
        permission: 'files.read',
        capability,
        query: FileStatsQuery,
        responses: { 200: { kind: 'json', schema: FileStats } },
    }),
    getFileUploadPolicy: defineRoute({
        id: 'getFileUploadPolicy',
        method: 'GET',
        path: '/files/upload-policy',
        summary: 'Get the size limit and accepted types for uploads of one purpose',
        description: 'Clients check a file against it before uploading; the upload route enforces the same policy.',
        permission: 'files.write',
        capability,
        query: FileUploadPolicyQuery,
        responses: { 200: { kind: 'json', schema: FileUploadPolicy } },
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
