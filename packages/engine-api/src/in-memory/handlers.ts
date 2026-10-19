import type { z } from 'zod';

import { AgentPermanentId, AgentId, RevisionId } from '../common';
import type { Agent, AgentRunState, AgentRunStatus } from '../agents';
import { ApiTokenId, ChatId, FileId, FolderId, InviteId, MessageId, SecretId } from '../common';
import type { ProblemDetails, Timestamp } from '../common';
import type { Message, ReplyStreamEvent } from '../chats';
import { MAX_FILE_BYTES } from '../constants';
import type { EngineEvent } from '../events';
import type { Member } from '../members';
import type { Permission } from '../permissions';
import { createProblem } from '../problem';
import type { ProblemExtras } from '../problem';
import type { ProblemCode } from '../problem-codes';
import type { EngineApiStreamItem, ParsedRouteRequest, RouteData } from '../route';
import type { ENGINE_API_ROUTES, EngineApiRouteId } from '../routes';
import { sha256OfBlob, verifyAuditChain } from './audit-chain';
import { checkBook } from './book';
import { paginate } from './paging';
import type { SortSpec, SortValue } from './paging';
import type { EventRecord, InMemoryState } from './state';

export type HandlerResult<T> =
    { readonly kind: 'ok'; readonly data: T } | { readonly kind: 'problem'; readonly problem: ProblemDetails };

export interface ScriptedReply {
    readonly chunks: readonly string[];
    /** `failed` ends the stream with `reply-failed` after the chunks. */
    readonly outcome?: 'completed' | 'failed';
}

export type ReplyScript = (input: { readonly agent: Agent; readonly content: string }) => ScriptedReply;

export interface HandlerContext {
    readonly state: InMemoryState;
    readonly member: Member;
    readonly permissions: ReadonlySet<Permission>;
    readonly now: () => Timestamp;
    readonly newId: <Schema extends z.ZodType<string, string>>(schema: Schema, prefix: string) => z.output<Schema>;
    readonly publish: (event: EngineEvent) => void;
    /** Resolves when an event after `count` events exists, rejects when `signal` aborts. */
    readonly nextEvent: (count: number, signal: AbortSignal) => Promise<void>;
    readonly replyScript: ReplyScript;
    readonly signal: AbortSignal;
}

type Routes = typeof ENGINE_API_ROUTES;
type Handler<Route> = (
    request: ParsedRouteRequest<Route>,
    ctx: HandlerContext,
) => HandlerResult<RouteData<Route>> | Promise<HandlerResult<RouteData<Route>>>;
export type Handlers = { readonly [Id in EngineApiRouteId]: Handler<Routes[Id]> };

const ok = <T>(data: T): HandlerResult<T> => ({ kind: 'ok', data });
const fail = (code: ProblemCode, extras?: ProblemExtras): HandlerResult<never> => ({
    kind: 'problem',
    problem: createProblem(code, extras),
});
const notFound = (what: string): HandlerResult<never> => fail('not-found', { detail: `No such ${what}.` });
const invalid = (path: string, message: string): HandlerResult<never> =>
    fail('validation-failed', { errors: [{ path, message }] });

function page<T>(
    items: Iterable<T>,
    spec: SortSpec<T>,
    query: { readonly cursor?: string | undefined; readonly limit: number },
): HandlerResult<{ items: T[]; nextCursor: string | null }> {
    const outcome = paginate([...items], spec, query);
    if (outcome.kind === 'invalid-cursor') return fail('invalid-cursor');
    return ok({ items: [...outcome.page.items], nextCursor: outcome.page.nextCursor });
}

function sortBy<T extends { readonly id: string }>(
    name: string,
    key: (item: T) => SortValue,
    descending = false,
): SortSpec<T> {
    return { name, key, descending, id: (item) => item.id };
}

/** `-name` style sort parameters: a leading `-` means descending. */
function sortParam<T extends { readonly id: string }>(sort: string, keys: Record<string, (item: T) => SortValue>) {
    const descending = sort.startsWith('-');
    const field = descending ? sort.slice(1) : sort;
    const key = keys[field];
    if (!key) throw new Error(`Unsupported sort ${sort}`);
    return sortBy(sort, key, descending);
}

const time = (timestamp: string): number => Date.parse(timestamp);

function agentRecord(ctx: HandlerContext, agentId: string) {
    return ctx.state.agents.get(agentId);
}

function liveAgent(ctx: HandlerContext, agentId: string): HandlerResult<Agent> {
    const record = agentRecord(ctx, agentId);
    if (!record) return notFound('agent');
    if (record.agent.deletedAt !== null) return fail('agent-deleted');
    return ok(record.agent);
}

function setRunState(ctx: HandlerContext, agentId: AgentId, state: AgentRunState): HandlerResult<AgentRunStatus> {
    const found = liveAgent(ctx, agentId);
    if (found.kind === 'problem') return found;
    const record = agentRecord(ctx, agentId);
    if (!record) return notFound('agent');
    if (record.runStatus.state !== state) {
        record.runStatus = { state, since: ctx.now() };
        ctx.publish({ type: 'agent.status', agentId, state, since: record.runStatus.since });
    }
    return ok(record.runStatus);
}

function touchChat(ctx: HandlerContext, chatId: ChatId): void {
    const chat = ctx.state.chats.get(chatId);
    if (chat) ctx.state.chats.set(chatId, { ...chat, updatedAt: ctx.now() });
    ctx.publish({ type: 'chat.changed', chatId });
}

/** The in-memory engine's behaviour for every route, after the transport checked permission and parsed the input. */
export const HANDLERS: Handlers = {
    getMe: (_, ctx) =>
        ok({
            memberId: ctx.member.id,
            orgId: ctx.state.orgId,
            displayName: ctx.member.displayName,
            role: ctx.member.role,
            permissions: [...ctx.permissions],
        }),
    getEngine: (_, ctx) => ok(ctx.state.engine),

    listAgents: ({ query }, ctx) => {
        const needle = query.q?.toLowerCase();
        const agents = [...ctx.state.agents.values()]
            .filter(({ agent, runStatus }) => {
                if (query.deleted === 'exclude' && agent.deletedAt !== null) return false;
                if (query.deleted === 'only' && agent.deletedAt === null) return false;
                if (query.folderId !== undefined && agent.folderId !== query.folderId) return false;
                if (query.visibility !== undefined && agent.visibility !== query.visibility) return false;
                if (query.status !== undefined && runStatus.state !== query.status) return false;
                if (needle === undefined) return true;
                return [agent.name, agent.profile.fullname, agent.profile.description].some((text) =>
                    text.toLowerCase().includes(needle),
                );
            })
            .map(({ agent }) => agent);
        return page(
            agents,
            sortParam<Agent>(query.sort, {
                name: (agent) => agent.name.toLowerCase(),
                updatedAt: (agent) => time(agent.updatedAt),
                createdAt: (agent) => time(agent.createdAt),
            }),
            query,
        );
    },
    createAgent: ({ body }, ctx) => {
        const book = checkBook(body.source);
        if (book.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
            return fail('invalid-book', { diagnostics: book.diagnostics });
        }
        if (body.folderId !== undefined && !ctx.state.folders.has(body.folderId)) {
            return invalid('body.folderId', 'No such folder.');
        }
        const now = ctx.now();
        const id = ctx.newId(AgentId, 'agent');
        const revisionId = ctx.newId(RevisionId, 'revision');
        const agent: Agent = {
            id,
            permanentId: AgentPermanentId.parse(`p-${id}`),
            name: book.name,
            profile: book.profile,
            visibility: body.visibility ?? ctx.state.settings.defaultAgentVisibility,
            folderId: body.folderId ?? null,
            currentRevisionId: revisionId,
            createdBy: ctx.member.id,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
        };
        ctx.state.agents.set(id, {
            agent,
            revisions: [{ id: revisionId, agentId: id, source: body.source, createdBy: ctx.member.id, createdAt: now }],
            runStatus: { state: 'idle', since: now },
        });
        ctx.publish({ type: 'agent.changed', agentId: id });
        return ok(agent);
    },
    validateAgentSource: ({ body }) => ok([...checkBook(body.source).diagnostics]),
    getAgent: ({ params }, ctx) => {
        const record = agentRecord(ctx, params.agentId);
        return record ? ok(record.agent) : notFound('agent');
    },
    updateAgent: ({ params, body }, ctx) => {
        const found = liveAgent(ctx, params.agentId);
        if (found.kind === 'problem') return found;
        if (body.folderId != null && !ctx.state.folders.has(body.folderId)) {
            return invalid('body.folderId', 'No such folder.');
        }
        return saveAgent(ctx, {
            ...found.data,
            ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
            ...(body.folderId === undefined ? {} : { folderId: body.folderId }),
            updatedAt: ctx.now(),
        });
    },
    deleteAgent: ({ params }, ctx) => {
        const record = agentRecord(ctx, params.agentId);
        if (!record) return notFound('agent');
        if (record.agent.deletedAt !== null) return ok(record.agent);
        const now = ctx.now();
        return saveAgent(ctx, { ...record.agent, deletedAt: now, updatedAt: now });
    },
    restoreAgent: ({ params }, ctx) => {
        const record = agentRecord(ctx, params.agentId);
        if (!record) return notFound('agent');
        if (record.agent.deletedAt === null) return ok(record.agent);
        return saveAgent(ctx, { ...record.agent, deletedAt: null, updatedAt: ctx.now() });
    },
    getAgentSource: ({ params }, ctx) => {
        const record = agentRecord(ctx, params.agentId);
        const current = record?.revisions.at(-1);
        if (!record || !current) return notFound('agent');
        return ok({
            agentId: record.agent.id,
            revisionId: current.id,
            source: current.source,
            updatedAt: current.createdAt,
        });
    },
    updateAgentSource: ({ params, body }, ctx) => {
        const found = liveAgent(ctx, params.agentId);
        if (found.kind === 'problem') return found;
        const agent = found.data;
        if (agent.currentRevisionId !== body.baseRevisionId) {
            return fail('revision-conflict', { detail: 'The source changed since this edit started.' });
        }
        const book = checkBook(body.source);
        if (book.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
            return fail('invalid-book', { diagnostics: book.diagnostics });
        }
        const now = ctx.now();
        const revisionId = ctx.newId(RevisionId, 'revision');
        agentRecord(ctx, agent.id)?.revisions.push({
            id: revisionId,
            agentId: agent.id,
            source: body.source,
            createdBy: ctx.member.id,
            createdAt: now,
        });
        saveAgent(ctx, {
            ...agent,
            name: book.name,
            profile: book.profile,
            currentRevisionId: revisionId,
            updatedAt: now,
        });
        return ok({ agentId: agent.id, revisionId, source: body.source, updatedAt: now });
    },
    listAgentRevisions: ({ params, query }, ctx) => {
        const record = agentRecord(ctx, params.agentId);
        if (!record) return notFound('agent');
        const summaries = record.revisions.map(({ id, agentId, createdBy, createdAt }) => ({
            id,
            agentId,
            createdBy,
            createdAt,
        }));
        return page(
            summaries,
            {
                name: 'newest',
                key: (revision) => record.revisions.findIndex((r) => r.id === revision.id),
                descending: true,
                id: (revision) => revision.id,
            },
            query,
        );
    },
    getAgentRevision: ({ params }, ctx) => {
        const revision = agentRecord(ctx, params.agentId)?.revisions.find(({ id }) => id === params.revisionId);
        return revision ? ok(revision) : notFound('revision');
    },
    getAgentStatus: ({ params }, ctx) => {
        const record = agentRecord(ctx, params.agentId);
        return record ? ok(record.runStatus) : notFound('agent');
    },
    startAgent: ({ params }, ctx) => setRunState(ctx, params.agentId, 'running'),
    stopAgent: ({ params }, ctx) => {
        const record = agentRecord(ctx, params.agentId);
        if (!record) return notFound('agent');
        if (record.runStatus.state !== 'running') return ok(record.runStatus);
        record.runStatus = { state: 'stopped', since: ctx.now() };
        ctx.publish({ type: 'agent.status', agentId: params.agentId, state: 'stopped', since: record.runStatus.since });
        return ok(record.runStatus);
    },

    streamEvents: ({ lastEventId }, ctx) => ok(streamEvents(ctx, lastEventId)),

    listFolders: ({ query }, ctx) =>
        page(
            ctx.state.folders.values(),
            sortBy('name', (folder) => folder.name.toLowerCase()),
            query,
        ),
    createFolder: ({ body }, ctx) => {
        if (folderNameTaken(ctx, body.name)) return fail('name-taken');
        const now = ctx.now();
        const folder = { id: ctx.newId(FolderId, 'folder'), name: body.name, createdAt: now, updatedAt: now };
        ctx.state.folders.set(folder.id, folder);
        return ok(folder);
    },
    renameFolder: ({ params, body }, ctx) => {
        const folder = ctx.state.folders.get(params.folderId);
        if (!folder) return notFound('folder');
        if (folderNameTaken(ctx, body.name, folder.id)) return fail('name-taken');
        const renamed = { ...folder, name: body.name, updatedAt: ctx.now() };
        ctx.state.folders.set(folder.id, renamed);
        return ok(renamed);
    },
    deleteFolder: ({ params }, ctx) => {
        if (!ctx.state.folders.has(params.folderId)) return notFound('folder');
        if ([...ctx.state.agents.values()].some(({ agent }) => agent.folderId === params.folderId)) {
            return fail('folder-not-empty');
        }
        ctx.state.folders.delete(params.folderId);
        return ok(null);
    },

    listAgentChats: ({ params, query }, ctx) => {
        if (!agentRecord(ctx, params.agentId)) return notFound('agent');
        const chats = [...ctx.state.chats.values()].filter((chat) => chat.agentId === params.agentId);
        return page(
            chats,
            sortBy('-updatedAt', (chat) => time(chat.updatedAt), true),
            query,
        );
    },
    createChat: ({ params, body }, ctx) => {
        const found = liveAgent(ctx, params.agentId);
        if (found.kind === 'problem') return found;
        const now = ctx.now();
        const chat = {
            id: ctx.newId(ChatId, 'chat'),
            agentId: params.agentId,
            title: body.title ?? '',
            createdBy: ctx.member.id,
            createdAt: now,
            updatedAt: now,
        };
        ctx.state.chats.set(chat.id, chat);
        ctx.publish({ type: 'chat.changed', chatId: chat.id });
        return ok(chat);
    },
    getChat: ({ params }, ctx) => {
        const chat = ctx.state.chats.get(params.chatId);
        return chat ? ok(chat) : notFound('chat');
    },
    listChatMessages: ({ params, query }, ctx) => {
        if (!ctx.state.chats.has(params.chatId)) return notFound('chat');
        const messages = [...ctx.state.messages.values()].filter((message) => message.chatId === params.chatId);
        return page(
            messages,
            sortBy('-createdAt', (message) => time(message.createdAt), true),
            query,
        );
    },
    sendChatMessage: ({ params, body }, ctx) => {
        const chat = ctx.state.chats.get(params.chatId);
        if (!chat) return notFound('chat');
        const found = liveAgent(ctx, chat.agentId);
        if (found.kind === 'problem') return found;
        const now = ctx.now();
        const userMessage: Message = {
            id: ctx.newId(MessageId, 'message'),
            chatId: chat.id,
            role: 'user',
            content: body.content,
            status: 'completed',
            createdBy: ctx.member.id,
            createdAt: now,
        };
        const reply: Message = {
            id: ctx.newId(MessageId, 'message'),
            chatId: chat.id,
            role: 'agent',
            content: '',
            status: 'streaming',
            createdBy: null,
            createdAt: now,
        };
        const script = ctx.replyScript({ agent: found.data, content: body.content });
        ctx.state.messages.set(userMessage.id, userMessage);
        ctx.state.messages.set(reply.id, reply);
        ctx.state.replies.set(reply.id, { chunks: [...script.chunks], outcome: script.outcome ?? 'completed' });
        touchChat(ctx, chat.id);
        return ok({ userMessage, replyMessageId: reply.id });
    },
    streamChatReply: ({ params, lastEventId }, ctx) => {
        const message = ctx.state.messages.get(params.messageId);
        const reply = ctx.state.replies.get(params.messageId);
        if (message?.chatId !== params.chatId || !reply) return notFound('reply');
        return ok(streamReply(ctx, message.id, lastEventId));
    },
    cancelChatReply: ({ params }, ctx) => {
        const message = ctx.state.messages.get(params.messageId);
        if (message?.chatId !== params.chatId || !ctx.state.replies.has(message.id)) return notFound('reply');
        if (message.status === 'cancelled') return ok(message);
        if (message.status !== 'streaming') return fail('reply-finished');
        const cancelled: Message = { ...message, status: 'cancelled' };
        ctx.state.messages.set(message.id, cancelled);
        touchChat(ctx, message.chatId);
        return ok(cancelled);
    },

    listMembers: ({ query }, ctx) =>
        page(
            ctx.state.members.values(),
            sortBy('displayName', (member) => member.displayName.toLowerCase()),
            query,
        ),
    getMember: ({ params }, ctx) => {
        const member = ctx.state.members.get(params.memberId);
        return member ? ok(member) : notFound('member');
    },
    updateMember: ({ params, body }, ctx) => {
        const member = ctx.state.members.get(params.memberId);
        if (!member) return notFound('member');
        const updated = { ...member, role: body.role };
        ctx.state.members.set(member.id, updated);
        return ok(updated);
    },
    removeMember: ({ params }, ctx) => {
        if (!ctx.state.members.delete(params.memberId)) return notFound('member');
        return ok(null);
    },
    listInvites: ({ query }, ctx) =>
        page(
            ctx.state.invites.values(),
            sortBy('-createdAt', (invite) => time(invite.createdAt), true),
            query,
        ),
    createInvite: ({ body }, ctx) => {
        if (time(body.expiresAt) <= time(ctx.now())) return invalid('body.expiresAt', 'Must be in the future.');
        const invite = {
            id: ctx.newId(InviteId, 'invite'),
            role: body.role,
            createdBy: ctx.member.id,
            createdAt: ctx.now(),
            expiresAt: body.expiresAt,
        };
        ctx.state.invites.set(invite.id, invite);
        return ok({ invite, inviteUrl: `https://${ctx.state.engine.hostname}/auth/invite#${invite.id}` });
    },
    revokeInvite: ({ params }, ctx) => (ctx.state.invites.delete(params.inviteId) ? ok(null) : notFound('invite')),

    listApiTokens: ({ query }, ctx) =>
        page(
            ctx.state.apiTokens.values(),
            sortBy('-createdAt', (token) => time(token.createdAt), true),
            query,
        ),
    createApiToken: ({ body }, ctx) => {
        const excess = body.permissions.find((permission) => !ctx.permissions.has(permission));
        if (excess !== undefined) return invalid('body.permissions', `You do not hold ${excess}.`);
        if (time(body.expiresAt) <= time(ctx.now())) return invalid('body.expiresAt', 'Must be in the future.');
        const apiToken = {
            id: ctx.newId(ApiTokenId, 'token'),
            name: body.name,
            permissions: [...new Set(body.permissions)],
            status: 'active' as const,
            createdBy: ctx.member.id,
            createdAt: ctx.now(),
            expiresAt: body.expiresAt,
            lastUsedAt: null,
        };
        ctx.state.apiTokens.set(apiToken.id, apiToken);
        return ok({ apiToken, token: `ptbk_in_memory_${apiToken.id}` });
    },
    revokeApiToken: ({ params }, ctx) => {
        const token = ctx.state.apiTokens.get(params.apiTokenId);
        if (!token) return notFound('API token');
        const revoked = { ...token, status: 'revoked' as const };
        ctx.state.apiTokens.set(token.id, revoked);
        return ok(revoked);
    },

    getSettings: (_, ctx) => ok(ctx.state.settings),
    updateSettings: ({ body }, ctx) => {
        ctx.state.settings = {
            ...ctx.state.settings,
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.defaultAgentVisibility === undefined
                ? {}
                : { defaultAgentVisibility: body.defaultAgentVisibility }),
        };
        ctx.state.engine = { ...ctx.state.engine, name: ctx.state.settings.name };
        return ok(ctx.state.settings);
    },
    setUpdatePolicy: ({ body }, ctx) => {
        const updatePolicy = {
            policy: body.policy,
            pinnedVersion: body.policy === 'pinned' ? body.pinnedVersion : null,
        };
        ctx.state.settings = { ...ctx.state.settings, updatePolicy };
        ctx.state.security = { ...ctx.state.security, update: { ...ctx.state.security.update, ...updatePolicy } };
        return ok(updatePolicy);
    },

    listPasskeys: ({ query }, ctx) => {
        const passkeys = [...ctx.state.passkeys.values()].filter(
            (passkey) => query.memberId === undefined || passkey.memberId === query.memberId,
        );
        return page(
            passkeys,
            sortBy('-createdAt', (passkey) => time(passkey.createdAt), true),
            query,
        );
    },
    revokePasskey: ({ params }, ctx) => {
        const passkey = ctx.state.passkeys.get(params.passkeyId);
        if (!passkey) return notFound('passkey');
        const remaining = [...ctx.state.passkeys.values()].filter(({ memberId }) => memberId === passkey.memberId);
        if (remaining.length === 1) return fail('last-passkey');
        ctx.state.passkeys.delete(passkey.id);
        return ok(null);
    },
    listSessions: ({ query }, ctx) => {
        const sessions = [...ctx.state.sessions.values()].filter(
            (session) => query.memberId === undefined || session.memberId === query.memberId,
        );
        return page(
            sessions,
            sortBy('-lastSeenAt', (session) => time(session.lastSeenAt), true),
            query,
        );
    },
    revokeSession: ({ params }, ctx) => (ctx.state.sessions.delete(params.sessionId) ? ok(null) : notFound('session')),

    listSecrets: ({ query }, ctx) => {
        const needle = query.q?.toLowerCase();
        const secrets = [...ctx.state.secrets.values()].filter((secret) => {
            if (needle !== undefined && !secret.name.toLowerCase().includes(needle)) return false;
            if (query.scope !== undefined && secret.scope.kind !== query.scope) return false;
            if (
                query.agentId !== undefined &&
                (secret.scope.kind !== 'agent' || secret.scope.agentId !== query.agentId)
            ) {
                return false;
            }
            return query.status === undefined || secret.status === query.status;
        });
        return page(
            secrets,
            sortParam(query.sort, {
                name: (secret) => secret.name.toLowerCase(),
                createdAt: (secret) => time(secret.createdAt),
                lastUsedAt: (secret) => (secret.lastUsedAt === null ? null : time(secret.lastUsedAt)),
            }),
            query,
        );
    },
    createSecret: ({ body }, ctx) => {
        if (body.scope.kind === 'agent' && !agentRecord(ctx, body.scope.agentId)) {
            return invalid('body.scope.agentId', 'No such agent.');
        }
        const sameScope = (scope: typeof body.scope): boolean =>
            scope.kind === body.scope.kind &&
            (scope.kind === 'engine' || body.scope.kind === 'engine' || scope.agentId === body.scope.agentId);
        if ([...ctx.state.secrets.values()].some((secret) => secret.name === body.name && sameScope(secret.scope))) {
            return fail('name-taken');
        }
        const now = ctx.now();
        const secret = {
            id: ctx.newId(SecretId, 'secret'),
            name: body.name,
            scope: body.scope,
            status: 'active' as const,
            createdBy: ctx.member.id,
            createdAt: now,
            updatedAt: now,
            lastUsedAt: null,
        };
        ctx.state.secrets.set(secret.id, secret);
        return ok(secret);
    },
    replaceSecretValue: ({ params }, ctx) => {
        const secret = ctx.state.secrets.get(params.secretId);
        if (!secret) return notFound('secret');
        if (secret.status === 'revoked') return fail('secret-revoked');
        const replaced = { ...secret, updatedAt: ctx.now() };
        ctx.state.secrets.set(secret.id, replaced);
        return ok(replaced);
    },
    revokeSecret: ({ params }, ctx) => {
        const secret = ctx.state.secrets.get(params.secretId);
        if (!secret) return notFound('secret');
        if (secret.status === 'revoked') return ok(secret);
        const revoked = { ...secret, status: 'revoked' as const, updatedAt: ctx.now() };
        ctx.state.secrets.set(secret.id, revoked);
        return ok(revoked);
    },
    deleteSecret: ({ params }, ctx) => (ctx.state.secrets.delete(params.secretId) ? ok(null) : notFound('secret')),

    listFiles: ({ query }, ctx) =>
        page(
            [...ctx.state.files.values()].map(({ metadata }) => metadata),
            sortBy('-createdAt', (file) => time(file.createdAt), true),
            query,
        ),
    uploadFile: async ({ body }, ctx) => {
        if (body.file.size > MAX_FILE_BYTES) return fail('payload-too-large');
        const metadata = {
            id: ctx.newId(FileId, 'file'),
            name: body.name,
            contentType: body.file.type === '' ? 'application/octet-stream' : body.file.type,
            sizeBytes: body.file.size,
            sha256: await sha256OfBlob(body.file),
            createdBy: ctx.member.id,
            createdAt: ctx.now(),
        };
        ctx.state.files.set(metadata.id, { metadata, content: body.file });
        return ok(metadata);
    },
    downloadFile: ({ params }, ctx) => {
        const file = ctx.state.files.get(params.fileId);
        return file ? ok(file.content) : notFound('file');
    },
    deleteFile: ({ params }, ctx) => (ctx.state.files.delete(params.fileId) ? ok(null) : notFound('file')),

    getSecurityOverview: (_, ctx) => ok(ctx.state.security),

    listAuditEntries: ({ query }, ctx) => {
        const from = query.from === undefined ? undefined : time(query.from);
        const to = query.to === undefined ? undefined : time(query.to);
        const entries = ctx.state.audit.filter((entry) => {
            const memberId = entry.actor.kind === 'system' ? undefined : entry.actor.memberId;
            if (query.memberId !== undefined && memberId !== query.memberId) return false;
            if (query.action !== undefined && entry.action !== query.action) return false;
            if (query.targetKind !== undefined && entry.target?.kind !== query.targetKind) return false;
            if (query.targetId !== undefined && entry.target?.id !== query.targetId) return false;
            if (query.outcome !== undefined && entry.outcome !== query.outcome) return false;
            if (from !== undefined && time(entry.at) < from) return false;
            return to === undefined || time(entry.at) < to;
        });
        return page(
            entries,
            { name: '-seq', key: (entry) => entry.seq, descending: true, id: (entry) => entry.id },
            query,
        );
    },
    verifyAuditLog: async (_, ctx) => ok(await verifyAuditChain(ctx.state.audit, ctx.now())),
};

function saveAgent(ctx: HandlerContext, agent: Agent): HandlerResult<Agent> {
    const record = agentRecord(ctx, agent.id);
    if (!record) return notFound('agent');
    record.agent = agent;
    ctx.publish({ type: 'agent.changed', agentId: agent.id });
    return ok(agent);
}

function folderNameTaken(ctx: HandlerContext, name: string, except?: string): boolean {
    const lower = name.toLowerCase();
    return [...ctx.state.folders.values()].some(
        (folder) => folder.id !== except && folder.name.toLowerCase() === lower,
    );
}

const EVENT_PERMISSION: Record<EngineEvent['type'], Permission> = {
    'agent.status': 'agents.read',
    'agent.changed': 'agents.read',
    'chat.changed': 'chats.read',
};

async function* streamEvents(
    ctx: HandlerContext,
    lastEventId: string | null,
): AsyncIterable<EngineApiStreamItem<EngineEvent>> {
    const events: readonly EventRecord[] = ctx.state.events;
    let next = lastEventId === null ? events.length : events.findIndex(({ id }) => id === lastEventId) + 1;
    for (;;) {
        while (next < events.length) {
            const record = events[next++];
            if (record && ctx.permissions.has(EVENT_PERMISSION[record.event.type])) {
                yield { id: record.id, event: record.event };
            }
        }
        await ctx.nextEvent(next, ctx.signal);
    }
}

/**
 * The in-memory engine has no model, so a reply "generates" as it is streamed: reading the stream to its end
 * completes the reply, and a cancel before that ends it with `cancelled`. Terminal events carry no SSE id of their
 * own, so they report the last delta's, exactly as an SSE parser would.
 */
async function* streamReply(
    ctx: HandlerContext,
    messageId: MessageId,
    lastEventId: string | null,
): AsyncIterable<EngineApiStreamItem<ReplyStreamEvent>> {
    const reply = ctx.state.replies.get(messageId);
    if (!reply) return;
    let id: string | null = null;
    const resumeAfter = lastEventId === null ? 0 : Number.parseInt(lastEventId, 10) || 0;
    for (let index = resumeAfter; index < reply.chunks.length; index++) {
        if (ctx.state.messages.get(messageId)?.status === 'cancelled') break;
        const seq = index + 1;
        id = String(seq);
        yield { id, event: { type: 'delta', seq, text: reply.chunks[index] ?? '' } };
        await Promise.resolve();
    }
    const message = ctx.state.messages.get(messageId);
    if (!message) return;
    if (message.status === 'cancelled') {
        yield { id, event: { type: 'failed', problem: createProblem('cancelled') } };
        return;
    }
    if (message.status === 'streaming') {
        const content = reply.chunks.join('');
        const finished: Message = { ...message, content, status: reply.outcome === 'failed' ? 'failed' : 'completed' };
        ctx.state.messages.set(messageId, finished);
        touchChat(ctx, finished.chatId);
    }
    const final = ctx.state.messages.get(messageId) ?? message;
    yield final.status === 'failed'
        ? { id, event: { type: 'failed', problem: createProblem('reply-failed') } }
        : { id, event: { type: 'completed', message: final } };
}
