import { AgentPermanentId, AgentId, RevisionId } from '../common';
import type { Agent, AgentRunState, AgentRunStatus } from '../agents';
import { ApiTokenId, FolderId, InviteId } from '../common';
import type { EngineEvent } from '../events';
import type { Member } from '../members';
import type { Passkey } from '../passkeys';
import type { EngineApiStreamItem } from '../route';
import type { Session } from '../sessions';
import { ACTIVITY_HANDLERS, canSeeEvent } from './activity';
import { verifyAuditChain } from './audit-chain';
import { checkBook } from './book';
import { FILE_HANDLERS } from './files';
import { INTEGRATION_HANDLERS } from './integrations';
import { agentRecord, fail, invalid, liveAgent, notFound, ok, page, sortBy, sortParam, time, within } from './kit';
import type { HandlerContext, HandlerResult, Handlers } from './kit';
import { cancelReply, retry, startTurn, streamReply } from './replies';
import { RUN_HANDLERS } from './runs';
import { TASK_HANDLERS } from './tasks';
import { ACCESS_REQUEST_HANDLERS, activeOwnerCount, signOutEverywhere } from './access-requests';
import { LIVE_HANDLERS } from './live';
import { ONBOARDING_HANDLERS } from './onboarding';
import { TEST_CHAT_HANDLERS } from './test-chat';
import {
    USER,
    answer,
    answeredQuestion,
    appendMessage,
    chatView,
    chatter,
    createThread,
    entriesOf,
    isMember,
    join,
    markSeen,
    requestKeyOf,
    respond,
    touch,
    trackRun,
} from './threads';
import { TRIGGER_HANDLERS } from './triggers';
import { WALLET_HANDLERS } from './wallet';
import type { InMemoryState } from './state';

export type { HandlerContext, HandlerResult, ReplyScript, ScriptedReply } from './kit';

function setRunState(ctx: HandlerContext, agentId: AgentId, state: AgentRunState): HandlerResult<AgentRunStatus> {
    const record = agentRecord(ctx, agentId);
    if (!record) return notFound('agent');
    if (record.agent.deletedAt !== null) return fail('agent-deleted');
    if (record.runStatus.state !== state) {
        record.runStatus = { state, since: ctx.now() };
        ctx.publish({ type: 'agent.status', agentId, state, since: record.runStatus.since });
    }
    return ok(record.runStatus);
}

/** `passkeyCount` is not stored: it is counted from the passkeys on every read. */
function withPasskeyCount(ctx: HandlerContext, member: Member): Member {
    let passkeyCount = 0;
    for (const passkey of ctx.state.passkeys.values()) if (passkey.memberId === member.id) passkeyCount++;
    return { ...member, passkeyCount };
}

function isLastOwner(ctx: HandlerContext, member: Member): boolean {
    return member.role === 'owner' && member.status === 'active' && activeOwnerCount(ctx.state) <= 1;
}

/** `current` is not stored: it is whether the session is the one making this request. */
function asSeenBy(ctx: HandlerContext, session: Session): Session {
    return { ...session, current: session.id === ctx.actor.sessionId };
}

/** The in-memory engine's behaviour for every route, after the transport checked permission and parsed the input. */
/** Expert and the engine's other `system` agents are defined by the engine itself; the API changes none of them. */
const engineOwned = () =>
    fail('agent-engine-owned', { detail: 'This agent is defined by the engine and cannot be changed here.' });

export const HANDLERS: Handlers = {
    getMe: (_, ctx) =>
        ok({
            memberId: ctx.member.id,
            orgId: ctx.state.orgId,
            displayName: ctx.member.displayName,
            role: ctx.member.role,
            permissions: [...ctx.permissions],
        }),
    listMyPasskeys: ({ query }, ctx) => {
        const own = [...ctx.state.passkeys.values()].filter(({ memberId }) => memberId === ctx.member.id);
        return page(
            own,
            sortBy('-createdAt', (passkey) => time(passkey.createdAt), true),
            query,
        );
    },
    revokeMyPasskey: ({ params }, ctx) => {
        const passkey = ctx.state.passkeys.get(params.passkeyId);
        // Someone else's passkey is reported exactly like a missing one, so IDs cannot be probed.
        if (passkey?.memberId !== ctx.member.id) return notFound('passkey');
        return revokePasskey(ctx, passkey);
    },
    listMySessions: ({ query }, ctx) => {
        const own = [...ctx.state.sessions.values()]
            .filter(({ memberId }) => memberId === ctx.member.id)
            .map((session) => asSeenBy(ctx, session));
        return page(
            own,
            sortBy('-lastSeenAt', (session) => time(session.lastSeenAt), true),
            query,
        );
    },
    revokeMySession: ({ params }, ctx) => {
        if (ctx.state.sessions.get(params.sessionId)?.memberId !== ctx.member.id) return notFound('session');
        ctx.state.sessions.delete(params.sessionId);
        return ok(null);
    },
    revokeMyOtherSessions: (_, ctx) => {
        let revoked = 0;
        for (const session of [...ctx.state.sessions.values()]) {
            if (session.memberId !== ctx.member.id || session.id === ctx.actor.sessionId) continue;
            ctx.state.sessions.delete(session.id);
            revoked++;
        }
        return ok({ revoked });
    },
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
                if (query.origin !== undefined && !query.origin.includes(agent.origin)) return false;
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
            origin: 'content',
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
        if (found.data.origin === 'system') return engineOwned();
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
        if (record.agent.origin === 'system') return engineOwned();
        if (record.agent.deletedAt !== null) return ok(record.agent);
        const now = ctx.now();
        return saveAgent(ctx, { ...record.agent, deletedAt: now, updatedAt: now });
    },
    restoreAgent: ({ params }, ctx) => {
        const record = agentRecord(ctx, params.agentId);
        if (!record) return notFound('agent');
        if (record.agent.origin === 'system') return engineOwned();
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
        if (found.data.origin === 'system') return engineOwned();
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
            // The owner chose the illustration, not the book, so a new source keeps it.
            profile:
                agent.profile.illustration === undefined
                    ? book.profile
                    : { ...book.profile, illustration: agent.profile.illustration },
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

    // Fixed now, not on the first read: the stream starts when the member subscribed.
    streamEvents: ({ lastEventId }, ctx) => ok(streamEvents(ctx, resumeAfter(ctx.state, lastEventId))),

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

    listChats: ({ query }, ctx) => {
        const needle = query.q?.toLowerCase();
        const chats = [...ctx.state.chats.values()].filter(
            (record) =>
                (query.agentId === undefined || isMember(record, { kind: 'agent', key: query.agentId })) &&
                (needle === undefined || record.title.toLowerCase().includes(needle)),
        );
        return page(
            chats.map((record) => chatView(ctx, record, ctx.member.id)),
            sortBy('-updatedAt', (chat) => time(chat.updatedAt), true),
            query,
        );
    },
    listAgentChats: ({ params, query }, ctx) => {
        if (!agentRecord(ctx, params.agentId)) return notFound('agent');
        const chats = [...ctx.state.chats.values()].filter((record) =>
            isMember(record, { kind: 'agent', key: params.agentId }),
        );
        return page(
            chats.map((record) => chatView(ctx, record, ctx.member.id)),
            sortBy('-updatedAt', (chat) => time(chat.updatedAt), true),
            query,
        );
    },
    createChat: ({ body }, ctx) => {
        const keyed = requestKeyOf(ctx, 'create', body.requestKey, { agentId: body.agentId, title: body.title });
        if (keyed.kind === 'reused') return fail('request-key-reused');
        if (keyed.kind === 'repeat') {
            const earlier = ctx.state.chats.get(keyed.id);
            return earlier ? ok(chatView(ctx, earlier, ctx.member.id)) : notFound('chat');
        }
        const agent = body.agentId === undefined ? chatter(ctx) : liveAgent(ctx, body.agentId);
        if (agent.kind === 'problem') return agent;
        const record = createThread(ctx, body.title === undefined ? {} : { title: body.title });
        if (body.title === undefined) record.title = `Chat with ${agent.data.name}`;
        join(ctx, record, USER);
        join(ctx, record, { kind: 'agent', key: agent.data.id });
        keyed.remember(record.id);
        touch(ctx, record);
        return ok(chatView(ctx, record, ctx.member.id));
    },
    getChat: ({ params }, ctx) => {
        const record = ctx.state.chats.get(params.chatId);
        return record ? ok(chatView(ctx, record, ctx.member.id)) : notFound('chat');
    },
    listChatEntries: ({ params, query }, ctx) => {
        const record = ctx.state.chats.get(params.chatId);
        if (!record) return notFound('chat');
        const position = new Map(record.entryIds.map((id, index) => [id, index]));
        return page(
            entriesOf(ctx, record),
            sortBy('-position', (entry) => position.get(entry.id) ?? 0, true),
            query,
        );
    },
    sendChatMessage: ({ params, body }, ctx) => {
        const record = ctx.state.chats.get(params.chatId);
        if (!record) return notFound('chat');
        const keyed = requestKeyOf(ctx, record.id, body.requestKey, { content: body.content, replyTo: body.replyTo });
        if (keyed.kind === 'reused') return fail('request-key-reused');
        if (keyed.kind === 'repeat') {
            const earlier = ctx.state.messages.get(keyed.id);
            return earlier ? ok({ message: earlier }) : notFound('message');
        }
        const answered = answeredQuestion(record, body.replyTo);
        const message = appendMessage(ctx, record, {
            author: USER,
            content: body.content,
            status: 'completed',
            createdBy: ctx.member.id,
        });
        keyed.remember(message.id);
        if (answered) answer(ctx, record, answered);
        record.readUpTo.set(ctx.member.id, record.entryIds.length);
        const turn = respond(ctx, record, message, answered);
        if (turn) startTurn(ctx, record, turn);
        touch(ctx, record);
        return ok({ message });
    },
    markChatRead: ({ params }, ctx) => {
        const record = ctx.state.chats.get(params.chatId);
        if (!record) return notFound('chat');
        if ((record.readUpTo.get(ctx.member.id) ?? 0) !== record.entryIds.length) {
            record.readUpTo.set(ctx.member.id, record.entryIds.length);
            touch(ctx, record, false);
        }
        return ok(chatView(ctx, record, ctx.member.id));
    },
    markChatSeen: ({ params, body }, ctx) => {
        const record = ctx.state.chats.get(params.chatId);
        if (!record) return notFound('chat');
        if (markSeen(ctx, record, body.messageIds)) touch(ctx, record);
        return ok(chatView(ctx, record, ctx.member.id));
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
        if (!cancelReply(ctx, message)) return fail('reply-finished');
        const cancelled = ctx.state.messages.get(message.id);
        return cancelled ? ok(cancelled) : notFound('reply');
    },
    retryChatReply: ({ params }, ctx) => {
        const record = ctx.state.chats.get(params.chatId);
        if (!record) return notFound('chat');
        const retried = retry(ctx, record, ctx.replyScript, (agent, reply, prompt) => {
            trackRun(ctx, record, agent, reply, prompt);
        });
        if (retried.kind === 'problem') return retried;
        return ok(chatView(ctx, record, ctx.member.id));
    },

    listMembers: ({ query }, ctx) =>
        page(
            [...ctx.state.members.values()].map((member) => withPasskeyCount(ctx, member)),
            sortBy('displayName', (member) => member.displayName.toLowerCase()),
            query,
        ),
    getMember: ({ params }, ctx) => {
        const member = ctx.state.members.get(params.memberId);
        return member ? ok(withPasskeyCount(ctx, member)) : notFound('member');
    },
    updateMember: ({ params, body }, ctx) => {
        const member = ctx.state.members.get(params.memberId);
        if (!member) return notFound('member');
        if (isLastOwner(ctx, member) && body.role !== 'owner') return fail('last-owner');
        const updated = { ...member, role: body.role };
        ctx.state.members.set(member.id, updated);
        return ok(withPasskeyCount(ctx, updated));
    },
    removeMember: ({ params }, ctx) => {
        const member = ctx.state.members.get(params.memberId);
        if (!member) return notFound('member');
        if (isLastOwner(ctx, member)) return fail('last-owner');
        ctx.state.members.delete(member.id);
        // A removed member is signed out everywhere: the gateway accepts only sessions the engine still lists.
        signOutEverywhere(ctx.state, member.id);
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
        return passkey ? revokePasskey(ctx, passkey) : notFound('passkey');
    },
    listSessions: ({ query }, ctx) => {
        const sessions = [...ctx.state.sessions.values()]
            .filter((session) => query.memberId === undefined || session.memberId === query.memberId)
            .map((session) => asSeenBy(ctx, session));
        return page(
            sessions,
            sortBy('-lastSeenAt', (session) => time(session.lastSeenAt), true),
            query,
        );
    },
    revokeSession: ({ params }, ctx) => (ctx.state.sessions.delete(params.sessionId) ? ok(null) : notFound('session')),

    getSecurityOverview: (_, ctx) => ok(ctx.state.security),

    listAuditEntries: ({ query }, ctx) => {
        const entries = ctx.state.audit.filter((entry) => {
            const memberId = entry.actor.kind === 'system' ? undefined : entry.actor.memberId;
            if (query.memberId !== undefined && memberId !== query.memberId) return false;
            if (query.action !== undefined && entry.action !== query.action) return false;
            if (query.targetKind !== undefined && entry.target?.kind !== query.targetKind) return false;
            if (query.targetId !== undefined && entry.target?.id !== query.targetId) return false;
            if (query.outcome !== undefined && entry.outcome !== query.outcome) return false;
            return within(entry.at, query.from, query.to);
        });
        return page(
            entries,
            { name: '-seq', key: (entry) => entry.seq, descending: true, id: (entry) => entry.id },
            query,
        );
    },
    verifyAuditLog: async (_, ctx) => ok(await verifyAuditChain(ctx.state.audit, ctx.now())),

    ...ACTIVITY_HANDLERS,
    ...RUN_HANDLERS,
    ...TASK_HANDLERS,
    ...FILE_HANDLERS,
    ...TRIGGER_HANDLERS,
    ...INTEGRATION_HANDLERS,
    ...TEST_CHAT_HANDLERS,
    ...ACCESS_REQUEST_HANDLERS,
    ...LIVE_HANDLERS,
    ...ONBOARDING_HANDLERS,
    ...WALLET_HANDLERS,
};

function saveAgent(ctx: HandlerContext, agent: Agent): HandlerResult<Agent> {
    const record = agentRecord(ctx, agent.id);
    if (!record) return notFound('agent');
    record.agent = agent;
    ctx.publish({ type: 'agent.changed', agentId: agent.id });
    return ok(agent);
}

function revokePasskey(ctx: HandlerContext, passkey: Passkey): HandlerResult<null> {
    const remaining = [...ctx.state.passkeys.values()].filter(({ memberId }) => memberId === passkey.memberId);
    if (remaining.length === 1) return fail('last-passkey');
    ctx.state.passkeys.delete(passkey.id);
    // A session lives no longer than the credential that signed it in, including the caller's own.
    for (const session of [...ctx.state.sessions.values()]) {
        if (session.passkeyId === passkey.id) ctx.state.sessions.delete(session.id);
    }
    return ok(null);
}

function folderNameTaken(ctx: HandlerContext, name: string, except?: string): boolean {
    const lower = name.toLowerCase();
    return [...ctx.state.folders.values()].some(
        (folder) => folder.id !== except && folder.name.toLowerCase() === lower,
    );
}

/**
 * Where a stream starts: after the last buffered event for a new subscriber, after `Last-Event-ID` while it is still
 * buffered, and otherwise (unknown or dropped) from the oldest buffered event.
 */
function resumeAfter(state: InMemoryState, lastEventId: string | null): number {
    if (lastEventId === null) return state.eventSeq;
    const buffered = state.events.find(({ id }) => id === lastEventId);
    if (buffered) return buffered.seq;
    const oldest = state.events[0];
    return oldest ? oldest.seq - 1 : state.eventSeq;
}

async function* streamEvents(ctx: HandlerContext, start: number): AsyncIterable<EngineApiStreamItem<EngineEvent>> {
    let after = start;
    for (;;) {
        // Looked up again each time: the buffer may have dropped events while this stream waited.
        const record = ctx.state.events.find(({ seq }) => seq > after);
        if (!record) {
            await ctx.nextEvent(after, ctx.signal);
            continue;
        }
        after = record.seq;
        if (canSeeEvent(ctx.permissions, record.event)) yield { id: record.id, event: record.event };
    }
}
