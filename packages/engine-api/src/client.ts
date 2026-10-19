import type { z } from 'zod';

import type { ProblemDetails } from './common';
import type { RouteData, RouteDefinition, RouteRequest } from './route';
import { ENGINE_API_ROUTES as R } from './routes';

/** Expected outcomes are values: a problem+json answer is data the caller must handle, not an exception. */
export type EngineApiResponse<T> =
    { readonly kind: 'ok'; readonly data: T } | { readonly kind: 'problem'; readonly problem: ProblemDetails };

/**
 * The engine answered something the contract does not allow. That is a bug on one side, never an expected outcome;
 * the message names the operation and what failed, never the response content.
 */
export class EngineApiContractError extends Error {
    readonly routeId: string;

    constructor(routeId: string, reason: string, options?: ErrorOptions) {
        super(`Engine API contract violation in ${routeId}: ${reason}`, options);
        this.name = 'EngineApiContractError';
        this.routeId = routeId;
    }
}

/** Untyped request as a transport sees it; the typed client builds it from a `RouteRequest`. */
export interface EngineApiTransportRequest {
    readonly params?: Readonly<Record<string, unknown>>;
    readonly query?: Readonly<Record<string, unknown>>;
    readonly body?: unknown;
    readonly lastEventId?: string;
}

/**
 * Executes one operation. A transport validates the success data against the route's schema (throwing
 * `EngineApiContractError`), so what it resolves with matches `RouteData<route>`.
 */
export type EngineApiTransport = (
    route: RouteDefinition,
    request: EngineApiTransportRequest,
    signal: AbortSignal,
) => Promise<EngineApiResponse<unknown>>;

type Routes = typeof R;
type Result<Id extends keyof Routes> = Promise<EngineApiResponse<RouteData<Routes[Id]>>>;
type Query<Id extends keyof Routes> = Routes[Id] extends { readonly query: infer Q extends z.ZodType }
    ? z.input<Q>
    : never;
type Body<Id extends keyof Routes> = Routes[Id] extends {
    readonly body: { readonly schema: infer B extends z.ZodType };
}
    ? z.input<B>
    : never;
type Param<Id extends keyof Routes, Key extends string> = Routes[Id] extends {
    readonly params: infer P extends z.ZodObject;
}
    ? z.input<P>[Key & keyof z.input<P>]
    : never;

export interface StreamOptions {
    /** Resume after this SSE id (`Last-Event-ID`). */
    readonly lastEventId?: string;
}

/**
 * The engine API as engine-ui sees it. Every method takes an `AbortSignal`; network failures, timeouts and aborts
 * reject, problem+json resolves as `{ kind: 'problem' }`.
 */
export interface EngineApiClient {
    /** The caller and their own credentials; none of these need a permission. */
    readonly me: {
        get(signal: AbortSignal): Result<'getMe'>;
        listPasskeys(query: Query<'listMyPasskeys'>, signal: AbortSignal): Result<'listMyPasskeys'>;
        revokePasskey(passkeyId: Param<'revokeMyPasskey', 'passkeyId'>, signal: AbortSignal): Result<'revokeMyPasskey'>;
        listSessions(query: Query<'listMySessions'>, signal: AbortSignal): Result<'listMySessions'>;
        revokeSession(sessionId: Param<'revokeMySession', 'sessionId'>, signal: AbortSignal): Result<'revokeMySession'>;
        /** Sign out everywhere else. */
        revokeOtherSessions(signal: AbortSignal): Result<'revokeMyOtherSessions'>;
    };
    readonly engine: {
        get(signal: AbortSignal): Result<'getEngine'>;
    };
    readonly agents: {
        list(query: Query<'listAgents'>, signal: AbortSignal): Result<'listAgents'>;
        create(body: Body<'createAgent'>, signal: AbortSignal): Result<'createAgent'>;
        validate(body: Body<'validateAgentSource'>, signal: AbortSignal): Result<'validateAgentSource'>;
        get(agentId: Param<'getAgent', 'agentId'>, signal: AbortSignal): Result<'getAgent'>;
        update(
            agentId: Param<'updateAgent', 'agentId'>,
            body: Body<'updateAgent'>,
            signal: AbortSignal,
        ): Result<'updateAgent'>;
        delete(agentId: Param<'deleteAgent', 'agentId'>, signal: AbortSignal): Result<'deleteAgent'>;
        restore(agentId: Param<'restoreAgent', 'agentId'>, signal: AbortSignal): Result<'restoreAgent'>;
        getSource(agentId: Param<'getAgentSource', 'agentId'>, signal: AbortSignal): Result<'getAgentSource'>;
        updateSource(
            agentId: Param<'updateAgentSource', 'agentId'>,
            body: Body<'updateAgentSource'>,
            signal: AbortSignal,
        ): Result<'updateAgentSource'>;
        listRevisions(
            agentId: Param<'listAgentRevisions', 'agentId'>,
            query: Query<'listAgentRevisions'>,
            signal: AbortSignal,
        ): Result<'listAgentRevisions'>;
        getRevision(
            agentId: Param<'getAgentRevision', 'agentId'>,
            revisionId: Param<'getAgentRevision', 'revisionId'>,
            signal: AbortSignal,
        ): Result<'getAgentRevision'>;
        getStatus(agentId: Param<'getAgentStatus', 'agentId'>, signal: AbortSignal): Result<'getAgentStatus'>;
        start(agentId: Param<'startAgent', 'agentId'>, signal: AbortSignal): Result<'startAgent'>;
        stop(agentId: Param<'stopAgent', 'agentId'>, signal: AbortSignal): Result<'stopAgent'>;
    };
    readonly events: {
        stream(options: StreamOptions, signal: AbortSignal): Result<'streamEvents'>;
    };
    readonly folders: {
        list(query: Query<'listFolders'>, signal: AbortSignal): Result<'listFolders'>;
        create(body: Body<'createFolder'>, signal: AbortSignal): Result<'createFolder'>;
        rename(
            folderId: Param<'renameFolder', 'folderId'>,
            body: Body<'renameFolder'>,
            signal: AbortSignal,
        ): Result<'renameFolder'>;
        delete(folderId: Param<'deleteFolder', 'folderId'>, signal: AbortSignal): Result<'deleteFolder'>;
    };
    readonly chats: {
        list(
            agentId: Param<'listAgentChats', 'agentId'>,
            query: Query<'listAgentChats'>,
            signal: AbortSignal,
        ): Result<'listAgentChats'>;
        create(
            agentId: Param<'createChat', 'agentId'>,
            body: Body<'createChat'>,
            signal: AbortSignal,
        ): Result<'createChat'>;
        get(chatId: Param<'getChat', 'chatId'>, signal: AbortSignal): Result<'getChat'>;
        listMessages(
            chatId: Param<'listChatMessages', 'chatId'>,
            query: Query<'listChatMessages'>,
            signal: AbortSignal,
        ): Result<'listChatMessages'>;
        sendMessage(
            chatId: Param<'sendChatMessage', 'chatId'>,
            body: Body<'sendChatMessage'>,
            signal: AbortSignal,
        ): Result<'sendChatMessage'>;
        streamReply(
            chatId: Param<'streamChatReply', 'chatId'>,
            messageId: Param<'streamChatReply', 'messageId'>,
            options: StreamOptions,
            signal: AbortSignal,
        ): Result<'streamChatReply'>;
        cancelReply(
            chatId: Param<'cancelChatReply', 'chatId'>,
            messageId: Param<'cancelChatReply', 'messageId'>,
            signal: AbortSignal,
        ): Result<'cancelChatReply'>;
    };
    readonly members: {
        list(query: Query<'listMembers'>, signal: AbortSignal): Result<'listMembers'>;
        get(memberId: Param<'getMember', 'memberId'>, signal: AbortSignal): Result<'getMember'>;
        update(
            memberId: Param<'updateMember', 'memberId'>,
            body: Body<'updateMember'>,
            signal: AbortSignal,
        ): Result<'updateMember'>;
        remove(memberId: Param<'removeMember', 'memberId'>, signal: AbortSignal): Result<'removeMember'>;
        listInvites(query: Query<'listInvites'>, signal: AbortSignal): Result<'listInvites'>;
        createInvite(body: Body<'createInvite'>, signal: AbortSignal): Result<'createInvite'>;
        revokeInvite(inviteId: Param<'revokeInvite', 'inviteId'>, signal: AbortSignal): Result<'revokeInvite'>;
    };
    readonly apiTokens: {
        list(query: Query<'listApiTokens'>, signal: AbortSignal): Result<'listApiTokens'>;
        create(body: Body<'createApiToken'>, signal: AbortSignal): Result<'createApiToken'>;
        revoke(apiTokenId: Param<'revokeApiToken', 'apiTokenId'>, signal: AbortSignal): Result<'revokeApiToken'>;
    };
    readonly settings: {
        get(signal: AbortSignal): Result<'getSettings'>;
        update(body: Body<'updateSettings'>, signal: AbortSignal): Result<'updateSettings'>;
        setUpdatePolicy(body: Body<'setUpdatePolicy'>, signal: AbortSignal): Result<'setUpdatePolicy'>;
    };
    readonly passkeys: {
        list(query: Query<'listPasskeys'>, signal: AbortSignal): Result<'listPasskeys'>;
        revoke(passkeyId: Param<'revokePasskey', 'passkeyId'>, signal: AbortSignal): Result<'revokePasskey'>;
    };
    readonly sessions: {
        list(query: Query<'listSessions'>, signal: AbortSignal): Result<'listSessions'>;
        revoke(sessionId: Param<'revokeSession', 'sessionId'>, signal: AbortSignal): Result<'revokeSession'>;
    };
    readonly secrets: {
        list(query: Query<'listSecrets'>, signal: AbortSignal): Result<'listSecrets'>;
        create(body: Body<'createSecret'>, signal: AbortSignal): Result<'createSecret'>;
        replaceValue(
            secretId: Param<'replaceSecretValue', 'secretId'>,
            body: Body<'replaceSecretValue'>,
            signal: AbortSignal,
        ): Result<'replaceSecretValue'>;
        revoke(secretId: Param<'revokeSecret', 'secretId'>, signal: AbortSignal): Result<'revokeSecret'>;
        delete(secretId: Param<'deleteSecret', 'secretId'>, signal: AbortSignal): Result<'deleteSecret'>;
    };
    readonly files: {
        list(query: Query<'listFiles'>, signal: AbortSignal): Result<'listFiles'>;
        upload(body: Body<'uploadFile'>, signal: AbortSignal): Result<'uploadFile'>;
        download(fileId: Param<'downloadFile', 'fileId'>, signal: AbortSignal): Result<'downloadFile'>;
        delete(fileId: Param<'deleteFile', 'fileId'>, signal: AbortSignal): Result<'deleteFile'>;
    };
    readonly security: {
        get(signal: AbortSignal): Result<'getSecurityOverview'>;
    };
    readonly audit: {
        list(query: Query<'listAuditEntries'>, signal: AbortSignal): Result<'listAuditEntries'>;
        verify(signal: AbortSignal): Result<'verifyAuditLog'>;
    };
}

/** Builds the typed client over any transport (HTTP, in-memory). */
export function createEngineApiClient(transport: EngineApiTransport): EngineApiClient {
    // The transport validated the data against the route's own schema, which is what `RouteData` is derived from.
    const call = <Route extends RouteDefinition>(
        route: Route,
        request: RouteRequest<Route>,
        signal: AbortSignal,
    ): Promise<EngineApiResponse<RouteData<Route>>> =>
        transport(route, request as EngineApiTransportRequest, signal) as Promise<EngineApiResponse<RouteData<Route>>>;

    return {
        me: {
            get: (signal) => call(R.getMe, {}, signal),
            listPasskeys: (query, signal) => call(R.listMyPasskeys, { query }, signal),
            revokePasskey: (passkeyId, signal) => call(R.revokeMyPasskey, { params: { passkeyId } }, signal),
            listSessions: (query, signal) => call(R.listMySessions, { query }, signal),
            revokeSession: (sessionId, signal) => call(R.revokeMySession, { params: { sessionId } }, signal),
            revokeOtherSessions: (signal) => call(R.revokeMyOtherSessions, {}, signal),
        },
        engine: { get: (signal) => call(R.getEngine, {}, signal) },
        agents: {
            list: (query, signal) => call(R.listAgents, { query }, signal),
            create: (body, signal) => call(R.createAgent, { body }, signal),
            validate: (body, signal) => call(R.validateAgentSource, { body }, signal),
            get: (agentId, signal) => call(R.getAgent, { params: { agentId } }, signal),
            update: (agentId, body, signal) => call(R.updateAgent, { params: { agentId }, body }, signal),
            delete: (agentId, signal) => call(R.deleteAgent, { params: { agentId } }, signal),
            restore: (agentId, signal) => call(R.restoreAgent, { params: { agentId } }, signal),
            getSource: (agentId, signal) => call(R.getAgentSource, { params: { agentId } }, signal),
            updateSource: (agentId, body, signal) => call(R.updateAgentSource, { params: { agentId }, body }, signal),
            listRevisions: (agentId, query, signal) =>
                call(R.listAgentRevisions, { params: { agentId }, query }, signal),
            getRevision: (agentId, revisionId, signal) =>
                call(R.getAgentRevision, { params: { agentId, revisionId } }, signal),
            getStatus: (agentId, signal) => call(R.getAgentStatus, { params: { agentId } }, signal),
            start: (agentId, signal) => call(R.startAgent, { params: { agentId } }, signal),
            stop: (agentId, signal) => call(R.stopAgent, { params: { agentId } }, signal),
        },
        events: {
            stream: (options, signal) => call(R.streamEvents, streamRequest(options), signal),
        },
        folders: {
            list: (query, signal) => call(R.listFolders, { query }, signal),
            create: (body, signal) => call(R.createFolder, { body }, signal),
            rename: (folderId, body, signal) => call(R.renameFolder, { params: { folderId }, body }, signal),
            delete: (folderId, signal) => call(R.deleteFolder, { params: { folderId } }, signal),
        },
        chats: {
            list: (agentId, query, signal) => call(R.listAgentChats, { params: { agentId }, query }, signal),
            create: (agentId, body, signal) => call(R.createChat, { params: { agentId }, body }, signal),
            get: (chatId, signal) => call(R.getChat, { params: { chatId } }, signal),
            listMessages: (chatId, query, signal) => call(R.listChatMessages, { params: { chatId }, query }, signal),
            sendMessage: (chatId, body, signal) => call(R.sendChatMessage, { params: { chatId }, body }, signal),
            streamReply: (chatId, messageId, options, signal) =>
                call(R.streamChatReply, { params: { chatId, messageId }, ...streamRequest(options) }, signal),
            cancelReply: (chatId, messageId, signal) =>
                call(R.cancelChatReply, { params: { chatId, messageId } }, signal),
        },
        members: {
            list: (query, signal) => call(R.listMembers, { query }, signal),
            get: (memberId, signal) => call(R.getMember, { params: { memberId } }, signal),
            update: (memberId, body, signal) => call(R.updateMember, { params: { memberId }, body }, signal),
            remove: (memberId, signal) => call(R.removeMember, { params: { memberId } }, signal),
            listInvites: (query, signal) => call(R.listInvites, { query }, signal),
            createInvite: (body, signal) => call(R.createInvite, { body }, signal),
            revokeInvite: (inviteId, signal) => call(R.revokeInvite, { params: { inviteId } }, signal),
        },
        apiTokens: {
            list: (query, signal) => call(R.listApiTokens, { query }, signal),
            create: (body, signal) => call(R.createApiToken, { body }, signal),
            revoke: (apiTokenId, signal) => call(R.revokeApiToken, { params: { apiTokenId } }, signal),
        },
        settings: {
            get: (signal) => call(R.getSettings, {}, signal),
            update: (body, signal) => call(R.updateSettings, { body }, signal),
            setUpdatePolicy: (body, signal) => call(R.setUpdatePolicy, { body }, signal),
        },
        passkeys: {
            list: (query, signal) => call(R.listPasskeys, { query }, signal),
            revoke: (passkeyId, signal) => call(R.revokePasskey, { params: { passkeyId } }, signal),
        },
        sessions: {
            list: (query, signal) => call(R.listSessions, { query }, signal),
            revoke: (sessionId, signal) => call(R.revokeSession, { params: { sessionId } }, signal),
        },
        secrets: {
            list: (query, signal) => call(R.listSecrets, { query }, signal),
            create: (body, signal) => call(R.createSecret, { body }, signal),
            replaceValue: (secretId, body, signal) =>
                call(R.replaceSecretValue, { params: { secretId }, body }, signal),
            revoke: (secretId, signal) => call(R.revokeSecret, { params: { secretId } }, signal),
            delete: (secretId, signal) => call(R.deleteSecret, { params: { secretId } }, signal),
        },
        files: {
            list: (query, signal) => call(R.listFiles, { query }, signal),
            upload: (body, signal) => call(R.uploadFile, { body }, signal),
            download: (fileId, signal) => call(R.downloadFile, { params: { fileId } }, signal),
            delete: (fileId, signal) => call(R.deleteFile, { params: { fileId } }, signal),
        },
        security: { get: (signal) => call(R.getSecurityOverview, {}, signal) },
        audit: {
            list: (query, signal) => call(R.listAuditEntries, { query }, signal),
            verify: (signal) => call(R.verifyAuditLog, {}, signal),
        },
    };
}

function streamRequest(options: StreamOptions): { readonly lastEventId?: string } {
    return options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId };
}
