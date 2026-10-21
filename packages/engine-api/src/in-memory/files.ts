import type { FileScan, FileStats, FileUploadPolicy } from '../capabilities/files';
import {
    acceptsFile,
    CommitHash,
    FILE_PURPOSES,
    FILE_SCAN_STATUSES,
    FileMetadata,
    FileName,
    FilePurpose,
    FileScanStatus,
    FileUploadPolicy as FileUploadPolicySchema,
} from '../capabilities/files';
import type { z } from 'zod';
import { AgentId, ChatId, FileId, FileVersionId, MemberId, RunId } from '../common';
import type { Timestamp } from '../common';
import { MAX_FILE_BYTES } from '../constants';
import { sha256OfBlob } from './audit-chain';
import { agentRecord, fail, invalid, memberActor, notFound, ok, page, recordActivity, sortParam, time } from './kit';
import type { EngineContext, Handlers } from './kit';
import { addRunOutputFile } from './runs';

/** Overrides per purpose; what is left out takes any type up to `MAX_FILE_BYTES`. */
export type FileUploadPolicies = Partial<
    Readonly<Record<FilePurpose, { readonly maxBytes?: number; readonly accept?: readonly string[] }>>
>;

/** Every purpose's policy, checked against the contract once when the core is created. */
export function resolveUploadPolicies(
    overrides: FileUploadPolicies = {},
): Readonly<Record<FilePurpose, FileUploadPolicy>> {
    const entries = FILE_PURPOSES.map((purpose) => {
        const override = overrides[purpose];
        return [
            purpose,
            FileUploadPolicySchema.parse({
                purpose,
                maxBytes: override?.maxBytes ?? MAX_FILE_BYTES,
                accept: override?.accept ?? [],
            }),
        ] as const;
    });
    return Object.fromEntries(entries) as Record<FilePurpose, FileUploadPolicy>;
}

function countBy<Key extends string>(keys: readonly Key[], of: readonly Key[]): Record<Key, number> {
    const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
    for (const key of of) counts[key] += 1;
    return counts;
}

/** A scan that is still running has not been checked yet. */
function scanOf(status: FileScanStatus, now: Timestamp): z.infer<typeof FileScan> {
    return { status, checkedAt: status === 'pending' ? null : now };
}

/** A file the engine stores on its own, e.g. a run's output; `scan` defaults to the engine's scanner. */
export interface NewFile {
    readonly name: string;
    readonly contentType: string;
    readonly content: Blob;
    readonly purpose: FilePurpose;
    readonly agentId?: string | null;
    readonly chatId?: string | null;
    /** The run that produced it; the file is added to the run's outputs. */
    readonly runId?: string | null;
    readonly createdBy: string;
    readonly scan?: FileScanStatus;
    /** For a git-backed project file, the commit that wrote it. */
    readonly commitHash?: string | null;
}

/** Stores a file as the system, with `file.created` activity and a change hint; throws on what does not exist. */
export async function addFile(ctx: EngineContext, input: NewFile): Promise<FileMetadata> {
    const agentId = input.agentId === undefined || input.agentId === null ? null : AgentId.parse(input.agentId);
    if (agentId !== null && !agentRecord(ctx, agentId)) throw new Error('file for an unknown agent');
    const runId = input.runId === undefined || input.runId === null ? null : RunId.parse(input.runId);
    if (runId !== null && !ctx.state.runs.has(runId)) throw new Error('file for an unknown run');
    const createdBy = MemberId.parse(input.createdBy);
    if (!ctx.state.members.has(createdBy)) throw new Error('file for an unknown member');
    const name = FileName.parse(input.name);
    const purpose = FilePurpose.parse(input.purpose);
    // Stamped before hashing, so the file's time and ID do not depend on how long the hash takes.
    const now = ctx.now();
    const id = ctx.newId(FileId, 'file');
    const versionId = ctx.newId(FileVersionId, 'version');
    const sha256 = await sha256OfBlob(input.content);
    const scan =
        input.scan ??
        ctx.checks.scanFile({ name, contentType: input.contentType, sizeBytes: input.content.size, purpose });
    const metadata = FileMetadata.parse({
        id,
        name,
        contentType: input.contentType,
        sizeBytes: input.content.size,
        sha256,
        purpose,
        agentId,
        chatId: input.chatId === undefined || input.chatId === null ? null : ChatId.parse(input.chatId),
        runId,
        scan: scanOf(FileScanStatus.parse(scan), now),
        versionCount: 1,
        createdBy,
        createdAt: now,
    });
    const version = {
        id: versionId,
        createdAt: now,
        sizeBytes: metadata.sizeBytes,
        sha256,
        commitHash:
            input.commitHash === undefined || input.commitHash === null ? null : CommitHash.parse(input.commitHash),
        runId,
    };
    ctx.state.files.set(metadata.id, { metadata, versions: [{ version, content: input.content }] });
    ctx.publish({ type: 'file.changed', fileId: metadata.id, agentId: metadata.agentId });
    recordActivity(ctx, {
        kind: 'file.created',
        agentId: metadata.agentId,
        actor: { kind: 'system' },
        fileId: metadata.id,
        name: metadata.name,
        purpose: metadata.purpose,
    });
    if (runId !== null) addRunOutputFile(ctx, runId, metadata);
    return metadata;
}

/** A scan finished (or started again); a failed scan is reported as `file.scan-failed`. */
export function setFileScan(ctx: EngineContext, fileId: string, status: FileScanStatus): FileMetadata {
    const record = ctx.state.files.get(fileId);
    if (!record) throw new Error(`No file ${fileId}`);
    const metadata = { ...record.metadata, scan: scanOf(FileScanStatus.parse(status), ctx.now()) };
    record.metadata = metadata;
    ctx.publish({ type: 'file.changed', fileId: metadata.id, agentId: metadata.agentId });
    if (status === 'failed') {
        recordActivity(ctx, {
            kind: 'file.scan-failed',
            agentId: metadata.agentId,
            actor: { kind: 'system' },
            fileId: metadata.id,
            name: metadata.name,
        });
    }
    return metadata;
}

export const FILE_HANDLERS: Pick<
    Handlers,
    | 'listFiles'
    | 'getFileStats'
    | 'getFileUploadPolicy'
    | 'uploadFile'
    | 'getFile'
    | 'listFileVersions'
    | 'downloadFile'
    | 'deleteFile'
> = {
    listFiles: ({ query }, ctx) => {
        const needle = query.q?.toLowerCase();
        const purposes = query.purpose === undefined ? undefined : new Set(query.purpose);
        const scans = query.scan === undefined ? undefined : new Set(query.scan);
        const files = [...ctx.state.files.values()]
            .map(({ metadata }) => metadata)
            .filter(
                (file) =>
                    (query.agentId === undefined || file.agentId === query.agentId) &&
                    (purposes === undefined || purposes.has(file.purpose)) &&
                    (scans === undefined || scans.has(file.scan.status)) &&
                    (needle === undefined || file.name.toLowerCase().includes(needle)),
            );
        return page(
            files,
            sortParam<FileMetadata>(query.sort, {
                createdAt: (file) => time(file.createdAt),
                name: (file) => file.name.toLowerCase(),
                sizeBytes: (file) => file.sizeBytes,
            }),
            query,
        );
    },
    getFileStats: ({ query }, ctx) => {
        const files = [...ctx.state.files.values()]
            .map(({ metadata }) => metadata)
            .filter((file) => query.agentId === undefined || file.agentId === query.agentId);
        const stats: FileStats = {
            byPurpose: countBy(
                FILE_PURPOSES,
                files.map((file) => file.purpose),
            ),
            byScan: countBy(
                FILE_SCAN_STATUSES,
                files.map((file) => file.scan.status),
            ),
        };
        return ok(stats);
    },
    getFileUploadPolicy: ({ query }, ctx) => ok(ctx.state.uploadPolicies[query.purpose]),
    uploadFile: async ({ body }, ctx) => {
        const policy = ctx.state.uploadPolicies[body.purpose];
        if (body.file.size > policy.maxBytes) return fail('payload-too-large');
        if (!acceptsFile(policy.accept, { name: body.name, type: body.file.type })) {
            return fail('unsupported-media-type');
        }
        if (body.agentId !== undefined && !agentRecord(ctx, body.agentId)) {
            return invalid('body.agentId', 'No such agent.');
        }
        const now = ctx.now();
        const sha256 = await sha256OfBlob(body.file);
        const contentType = body.file.type === '' ? 'application/octet-stream' : body.file.type;
        const scan = ctx.checks.scanFile({
            name: body.name,
            contentType,
            sizeBytes: body.file.size,
            purpose: body.purpose,
        });
        const metadata: FileMetadata = {
            id: ctx.newId(FileId, 'file'),
            name: body.name,
            contentType,
            sizeBytes: body.file.size,
            sha256,
            purpose: body.purpose,
            agentId: body.agentId ?? null,
            chatId: null,
            runId: null,
            scan: scanOf(scan, now),
            versionCount: 1,
            createdBy: ctx.member.id,
            createdAt: now,
        };
        const version = {
            id: ctx.newId(FileVersionId, 'version'),
            createdAt: now,
            sizeBytes: metadata.sizeBytes,
            sha256,
            commitHash: null,
            runId: null,
        };
        ctx.state.files.set(metadata.id, { metadata, versions: [{ version, content: body.file }] });
        ctx.publish({ type: 'file.changed', fileId: metadata.id, agentId: metadata.agentId });
        recordActivity(ctx, {
            kind: 'file.created',
            agentId: metadata.agentId,
            actor: memberActor(ctx),
            fileId: metadata.id,
            name: metadata.name,
            purpose: metadata.purpose,
        });
        return ok(metadata);
    },
    getFile: ({ params }, ctx) => {
        const file = ctx.state.files.get(params.fileId);
        return file ? ok(file.metadata) : notFound('file');
    },
    listFileVersions: ({ params, query }, ctx) => {
        const file = ctx.state.files.get(params.fileId);
        if (!file) return notFound('file');
        const order = new Map(file.versions.map(({ version }, index) => [version.id, index]));
        return page(
            file.versions.map(({ version }) => version),
            { name: 'newest', key: (version) => order.get(version.id) ?? 0, descending: true, id: (v) => v.id },
            query,
        );
    },
    downloadFile: ({ params, query }, ctx) => {
        const file = ctx.state.files.get(params.fileId);
        if (!file) return notFound('file');
        if (file.metadata.scan.status === 'infected') return fail('file-infected');
        const version =
            query.version === undefined
                ? file.versions.at(-1)
                : file.versions.find(({ version: candidate }) => candidate.id === query.version);
        return version ? ok(version.content) : notFound('file version');
    },
    deleteFile: ({ params }, ctx) => {
        const file = ctx.state.files.get(params.fileId);
        if (!file) return notFound('file');
        ctx.state.files.delete(params.fileId);
        ctx.publish({ type: 'file.changed', fileId: file.metadata.id, agentId: file.metadata.agentId });
        recordActivity(ctx, {
            kind: 'file.deleted',
            agentId: file.metadata.agentId,
            actor: memberActor(ctx),
            fileId: file.metadata.id,
            name: file.metadata.name,
        });
        return ok(null);
    },
};
