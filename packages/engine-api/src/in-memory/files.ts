import type { FileMetadata } from '../capabilities/files';
import { FileId, FileVersionId } from '../common';
import { MAX_FILE_BYTES } from '../constants';
import { sha256OfBlob } from './audit-chain';
import { agentRecord, fail, invalid, memberActor, notFound, ok, page, recordActivity, sortParam, time } from './kit';
import type { Handlers } from './kit';

export const FILE_HANDLERS: Pick<
    Handlers,
    'listFiles' | 'uploadFile' | 'getFile' | 'listFileVersions' | 'downloadFile' | 'deleteFile'
> = {
    listFiles: ({ query }, ctx) => {
        const needle = query.q?.toLowerCase();
        const files = [...ctx.state.files.values()]
            .map(({ metadata }) => metadata)
            .filter(
                (file) =>
                    (query.agentId === undefined || file.agentId === query.agentId) &&
                    (query.purpose === undefined || file.purpose === query.purpose) &&
                    (query.scan === undefined || file.scan.status === query.scan) &&
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
    uploadFile: async ({ body }, ctx) => {
        if (body.file.size > MAX_FILE_BYTES) return fail('payload-too-large');
        if (body.agentId !== undefined && !agentRecord(ctx, body.agentId)) {
            return invalid('body.agentId', 'No such agent.');
        }
        const now = ctx.now();
        const sha256 = await sha256OfBlob(body.file);
        // The in-memory engine has no scanner, so every upload is clean the moment it is stored.
        const metadata: FileMetadata = {
            id: ctx.newId(FileId, 'file'),
            name: body.name,
            contentType: body.file.type === '' ? 'application/octet-stream' : body.file.type,
            sizeBytes: body.file.size,
            sha256,
            purpose: body.purpose,
            agentId: body.agentId ?? null,
            chatId: null,
            runId: null,
            scan: { status: 'clean', checkedAt: now },
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
