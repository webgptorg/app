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
    /** For a multipart body: how much of it has been sent. */
    readonly onUploadProgress?: (progress: UploadProgress) => void;
}

/** Bytes of a request body sent so far; `totalBytes` is the encoded body's size, so it can exceed the file's. */
export interface UploadProgress {
    readonly loadedBytes: number;
    readonly totalBytes: number;
}

export interface UploadOptions {
    /**
     * Called as the body is sent, ending with `loadedBytes === totalBytes`. How often depends on the transport: a
     * transport that cannot observe the upload reports only the end.
     */
    readonly onProgress?: (progress: UploadProgress) => void;
}

/**
 * Executes one operation. A client transport reads the success data with the route's tolerant reader (throwing
 * `EngineApiContractError` when it does not match), so what it resolves with matches `RouteData<route>`.
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
        /** Every thread the member can see. */
        listAll(query: Query<'listChats'>, signal: AbortSignal): Result<'listChats'>;
        list(
            agentId: Param<'listAgentChats', 'agentId'>,
            query: Query<'listAgentChats'>,
            signal: AbortSignal,
        ): Result<'listAgentChats'>;
        /** A thread with Chatter, or with the agent the body names. */
        create(body: Body<'createChat'>, signal: AbortSignal): Result<'createChat'>;
        get(chatId: Param<'getChat', 'chatId'>, signal: AbortSignal): Result<'getChat'>;
        listEntries(
            chatId: Param<'listChatEntries', 'chatId'>,
            query: Query<'listChatEntries'>,
            signal: AbortSignal,
        ): Result<'listChatEntries'>;
        sendMessage(
            chatId: Param<'sendChatMessage', 'chatId'>,
            body: Body<'sendChatMessage'>,
            signal: AbortSignal,
        ): Result<'sendChatMessage'>;
        markRead(chatId: Param<'markChatRead', 'chatId'>, signal: AbortSignal): Result<'markChatRead'>;
        markSeen(
            chatId: Param<'markChatSeen', 'chatId'>,
            body: Body<'markChatSeen'>,
            signal: AbortSignal,
        ): Result<'markChatSeen'>;
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
        /** Attempts the thread's failed reply now instead of at its `recheck.nextAt`. */
        retry(chatId: Param<'retryChatReply', 'chatId'>, signal: AbortSignal): Result<'retryChatReply'>;
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
        /** `access-requests@1`. */
        listAccessRequests(query: Query<'listAccessRequests'>, signal: AbortSignal): Result<'listAccessRequests'>;
        approveAccessRequest(
            accessRequestId: Param<'approveAccessRequest', 'accessRequestId'>,
            body: Body<'approveAccessRequest'>,
            signal: AbortSignal,
        ): Result<'approveAccessRequest'>;
        declineAccessRequest(
            accessRequestId: Param<'declineAccessRequest', 'accessRequestId'>,
            signal: AbortSignal,
        ): Result<'declineAccessRequest'>;
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
        /** `access-requests@1`. */
        setDashboardRemovals(body: Body<'setDashboardRemovals'>, signal: AbortSignal): Result<'setDashboardRemovals'>;
    };
    readonly passkeys: {
        list(query: Query<'listPasskeys'>, signal: AbortSignal): Result<'listPasskeys'>;
        revoke(passkeyId: Param<'revokePasskey', 'passkeyId'>, signal: AbortSignal): Result<'revokePasskey'>;
    };
    readonly sessions: {
        list(query: Query<'listSessions'>, signal: AbortSignal): Result<'listSessions'>;
        revoke(sessionId: Param<'revokeSession', 'sessionId'>, signal: AbortSignal): Result<'revokeSession'>;
    };
    /** `wallet@1`. */
    readonly wallet: {
        get(signal: AbortSignal): Result<'getWallet'>;
        add(body: Body<'addWalletRecord'>, signal: AbortSignal): Result<'addWalletRecord'>;
        update(
            recordId: Param<'updateWalletRecord', 'recordId'>,
            body: Body<'updateWalletRecord'>,
            signal: AbortSignal,
        ): Result<'updateWalletRecord'>;
        delete(recordId: Param<'deleteWalletRecord', 'recordId'>, signal: AbortSignal): Result<'deleteWalletRecord'>;
        markSeen(
            requestId: Param<'markWalletRequestSeen', 'requestId'>,
            body: Body<'markWalletRequestSeen'>,
            signal: AbortSignal,
        ): Result<'markWalletRequestSeen'>;
        reject(
            requestId: Param<'rejectWalletRequest', 'requestId'>,
            body: Body<'rejectWalletRequest'>,
            signal: AbortSignal,
        ): Result<'rejectWalletRequest'>;
    };
    /**
     * `browser-tab@1` (draft): watch and take over agents' tabs, sign in in a fresh tab, help requests. The frames and
     * input flow over the session's channel (`LIVE_CHANNEL_PATH`), a WebSocket the client opens itself.
     */
    readonly browser: {
        openSignIn(body: Body<'openBrowserSignIn'>, signal: AbortSignal): Result<'openBrowserSignIn'>;
        listTabs(query: Query<'listBrowserTabs'>, signal: AbortSignal): Result<'listBrowserTabs'>;
        watch(tabId: Param<'watchBrowserTab', 'tabId'>, signal: AbortSignal): Result<'watchBrowserTab'>;
        control(tabId: Param<'controlBrowserTab', 'tabId'>, signal: AbortSignal): Result<'controlBrowserTab'>;
        getSession(
            sessionId: Param<'getBrowserSession', 'sessionId'>,
            signal: AbortSignal,
        ): Result<'getBrowserSession'>;
        takeControl(
            sessionId: Param<'takeBrowserControl', 'sessionId'>,
            signal: AbortSignal,
        ): Result<'takeBrowserControl'>;
        handBack(
            sessionId: Param<'handBackBrowserTab', 'sessionId'>,
            signal: AbortSignal,
        ): Result<'handBackBrowserTab'>;
        end(sessionId: Param<'endBrowserSession', 'sessionId'>, signal: AbortSignal): Result<'endBrowserSession'>;
        listHelpRequests(
            query: Query<'listBrowserHelpRequests'>,
            signal: AbortSignal,
        ): Result<'listBrowserHelpRequests'>;
        getHelpRequest(
            requestId: Param<'getBrowserHelpRequest', 'requestId'>,
            signal: AbortSignal,
        ): Result<'getBrowserHelpRequest'>;
        dismissHelpRequest(
            requestId: Param<'dismissBrowserHelpRequest', 'requestId'>,
            signal: AbortSignal,
        ): Result<'dismissBrowserHelpRequest'>;
    };
    /** `files@1`; every capability group answers 404 `capability-not-supported` unless `GET /engine` advertises it. */
    readonly files: {
        list(query: Query<'listFiles'>, signal: AbortSignal): Result<'listFiles'>;
        stats(query: Query<'getFileStats'>, signal: AbortSignal): Result<'getFileStats'>;
        uploadPolicy(query: Query<'getFileUploadPolicy'>, signal: AbortSignal): Result<'getFileUploadPolicy'>;
        upload(body: Body<'uploadFile'>, signal: AbortSignal, options?: UploadOptions): Result<'uploadFile'>;
        get(fileId: Param<'getFile', 'fileId'>, signal: AbortSignal): Result<'getFile'>;
        listVersions(
            fileId: Param<'listFileVersions', 'fileId'>,
            query: Query<'listFileVersions'>,
            signal: AbortSignal,
        ): Result<'listFileVersions'>;
        download(
            fileId: Param<'downloadFile', 'fileId'>,
            query: Query<'downloadFile'>,
            signal: AbortSignal,
        ): Result<'downloadFile'>;
        delete(fileId: Param<'deleteFile', 'fileId'>, signal: AbortSignal): Result<'deleteFile'>;
    };
    /** `runs@1`. Runs start from a chat message or a trigger, never from here. */
    readonly runs: {
        list(query: Query<'listRuns'>, signal: AbortSignal): Result<'listRuns'>;
        stats(query: Query<'getRunStats'>, signal: AbortSignal): Result<'getRunStats'>;
        get(runId: Param<'getRun', 'runId'>, signal: AbortSignal): Result<'getRun'>;
        cancel(runId: Param<'cancelRun', 'runId'>, signal: AbortSignal): Result<'cancelRun'>;
        retry(runId: Param<'retryRun', 'runId'>, signal: AbortSignal): Result<'retryRun'>;
    };
    /** `tasks@1`, read-only: work changes through a conversation with Chatter. */
    readonly tasks: {
        list(query: Query<'listTasks'>, signal: AbortSignal): Result<'listTasks'>;
        get(taskId: Param<'getTask', 'taskId'>, signal: AbortSignal): Result<'getTask'>;
        listOccurrences(
            taskId: Param<'listTaskOccurrences', 'taskId'>,
            query: Query<'listTaskOccurrences'>,
            signal: AbortSignal,
        ): Result<'listTaskOccurrences'>;
    };
    /** `test-chat@1`: a reply to an unsaved book, which the engine does not store. Abort the signal to stop it. */
    readonly testChat: {
        stream(
            agentId: Param<'testAgentDraft', 'agentId'>,
            body: Body<'testAgentDraft'>,
            signal: AbortSignal,
        ): Result<'testAgentDraft'>;
    };
    /** `triggers@1`. */
    readonly triggers: {
        list(query: Query<'listTriggers'>, signal: AbortSignal): Result<'listTriggers'>;
        stats(query: Query<'getTriggerStats'>, signal: AbortSignal): Result<'getTriggerStats'>;
        create(body: Body<'createTrigger'>, signal: AbortSignal): Result<'createTrigger'>;
        get(triggerId: Param<'getTrigger', 'triggerId'>, signal: AbortSignal): Result<'getTrigger'>;
        update(
            triggerId: Param<'updateTrigger', 'triggerId'>,
            body: Body<'updateTrigger'>,
            signal: AbortSignal,
        ): Result<'updateTrigger'>;
        delete(triggerId: Param<'deleteTrigger', 'triggerId'>, signal: AbortSignal): Result<'deleteTrigger'>;
        pause(triggerId: Param<'pauseTrigger', 'triggerId'>, signal: AbortSignal): Result<'pauseTrigger'>;
        resume(triggerId: Param<'resumeTrigger', 'triggerId'>, signal: AbortSignal): Result<'resumeTrigger'>;
        listFires(
            triggerId: Param<'listTriggerFires', 'triggerId'>,
            query: Query<'listTriggerFires'>,
            signal: AbortSignal,
        ): Result<'listTriggerFires'>;
    };
    /** `integrations@1`. Integrations of a kind this client does not know read as `{ kind: 'unknown', rawKind }`. */
    readonly integrations: {
        list(query: Query<'listIntegrations'>, signal: AbortSignal): Result<'listIntegrations'>;
        stats(query: Query<'getIntegrationStats'>, signal: AbortSignal): Result<'getIntegrationStats'>;
        create(body: Body<'createIntegration'>, signal: AbortSignal): Result<'createIntegration'>;
        connectCalendar(body: Body<'connectCalendar'>, signal: AbortSignal): Result<'connectCalendar'>;
        get(integrationId: Param<'getIntegration', 'integrationId'>, signal: AbortSignal): Result<'getIntegration'>;
        update(
            integrationId: Param<'updateIntegration', 'integrationId'>,
            body: Body<'updateIntegration'>,
            signal: AbortSignal,
        ): Result<'updateIntegration'>;
        delete(
            integrationId: Param<'deleteIntegration', 'integrationId'>,
            signal: AbortSignal,
        ): Result<'deleteIntegration'>;
        enable(
            integrationId: Param<'enableIntegration', 'integrationId'>,
            signal: AbortSignal,
        ): Result<'enableIntegration'>;
        disable(
            integrationId: Param<'disableIntegration', 'integrationId'>,
            signal: AbortSignal,
        ): Result<'disableIntegration'>;
        check(
            integrationId: Param<'checkIntegration', 'integrationId'>,
            signal: AbortSignal,
        ): Result<'checkIntegration'>;
    };
    /** `onboarding@1`: the engine asks, the UI answers; poll `get` while the engine works or a login waits. */
    readonly onboarding: {
        get(signal: AbortSignal): Result<'getOnboarding'>;
        answer(body: Body<'answerOnboarding'>, signal: AbortSignal): Result<'answerOnboarding'>;
        defer(signal: AbortSignal): Result<'deferOnboarding'>;
    };
    /**
     * `voice-input@1` and `voice-output@1`, each on its own. A transcript is a draft for the composer; only
     * `chats.sendMessage` puts anything in the chat.
     */
    readonly voice: {
        /** The clip's `type` is sent as its `Content-Type` and must be one of `VOICE_CLIP_FORMATS`. */
        transcribe(
            chatId: Param<'transcribeVoiceClip', 'chatId'>,
            clip: Blob,
            query: Query<'transcribeVoiceClip'>,
            signal: AbortSignal,
        ): Result<'transcribeVoiceClip'>;
        /** Resolves with the audio; its `type` is the one of `body.formats` the engine chose. */
        speak(
            chatId: Param<'speakChatMessage', 'chatId'>,
            messageId: Param<'speakChatMessage', 'messageId'>,
            body: Body<'speakChatMessage'>,
            signal: AbortSignal,
        ): Result<'speakChatMessage'>;
    };
    /**
     * `ai-tools@1`: the project's AI tools. A sign-in belongs to the session that started it; poll `getSignIn` while
     * it is `working` or its login waits. A key goes in `answerSignIn` only, and comes back nowhere.
     */
    readonly aiTools: {
        list(signal: AbortSignal): Result<'listAiTools'>;
        get(aiToolId: Param<'getAiTool', 'aiToolId'>, signal: AbortSignal): Result<'getAiTool'>;
        check(aiToolId: Param<'checkAiTool', 'aiToolId'>, signal: AbortSignal): Result<'checkAiTool'>;
        startSignIn(
            aiToolId: Param<'startAiToolSignIn', 'aiToolId'>,
            body: Body<'startAiToolSignIn'>,
            signal: AbortSignal,
        ): Result<'startAiToolSignIn'>;
        getSignIn(
            aiToolId: Param<'getAiToolSignIn', 'aiToolId'>,
            signInId: Param<'getAiToolSignIn', 'signInId'>,
            signal: AbortSignal,
        ): Result<'getAiToolSignIn'>;
        answerSignIn(
            aiToolId: Param<'answerAiToolSignIn', 'aiToolId'>,
            signInId: Param<'answerAiToolSignIn', 'signInId'>,
            body: Body<'answerAiToolSignIn'>,
            signal: AbortSignal,
        ): Result<'answerAiToolSignIn'>;
        cancelSignIn(
            aiToolId: Param<'cancelAiToolSignIn', 'aiToolId'>,
            signInId: Param<'cancelAiToolSignIn', 'signInId'>,
            signal: AbortSignal,
        ): Result<'cancelAiToolSignIn'>;
        signOut(aiToolId: Param<'signOutAiTool', 'aiToolId'>, signal: AbortSignal): Result<'signOutAiTool'>;
    };
    /** Items of unknown kinds read as `{ kind: 'unknown' }`; items without a valid base are dropped and counted. */
    readonly activity: {
        list(query: Query<'listActivity'>, signal: AbortSignal): Result<'listActivity'>;
    };
    readonly security: {
        get(signal: AbortSignal): Result<'getSecurityOverview'>;
    };
    /** `updates@1`: the UI loader's normal check, run now; its result, or why it did not run. */
    readonly updates: {
        checkUi(signal: AbortSignal): Result<'checkForUiUpdate'>;
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
        onUploadProgress?: (progress: UploadProgress) => void,
    ): Promise<EngineApiResponse<RouteData<Route>>> =>
        transport(
            route,
            onUploadProgress === undefined
                ? (request as EngineApiTransportRequest)
                : { ...(request as EngineApiTransportRequest), onUploadProgress },
            signal,
        ) as Promise<EngineApiResponse<RouteData<Route>>>;

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
            listAll: (query, signal) => call(R.listChats, { query }, signal),
            list: (agentId, query, signal) => call(R.listAgentChats, { params: { agentId }, query }, signal),
            create: (body, signal) => call(R.createChat, { body }, signal),
            get: (chatId, signal) => call(R.getChat, { params: { chatId } }, signal),
            listEntries: (chatId, query, signal) => call(R.listChatEntries, { params: { chatId }, query }, signal),
            sendMessage: (chatId, body, signal) => call(R.sendChatMessage, { params: { chatId }, body }, signal),
            markRead: (chatId, signal) => call(R.markChatRead, { params: { chatId } }, signal),
            markSeen: (chatId, body, signal) => call(R.markChatSeen, { params: { chatId }, body }, signal),
            streamReply: (chatId, messageId, options, signal) =>
                call(R.streamChatReply, { params: { chatId, messageId }, ...streamRequest(options) }, signal),
            cancelReply: (chatId, messageId, signal) =>
                call(R.cancelChatReply, { params: { chatId, messageId } }, signal),
            retry: (chatId, signal) => call(R.retryChatReply, { params: { chatId } }, signal),
        },
        members: {
            list: (query, signal) => call(R.listMembers, { query }, signal),
            get: (memberId, signal) => call(R.getMember, { params: { memberId } }, signal),
            update: (memberId, body, signal) => call(R.updateMember, { params: { memberId }, body }, signal),
            remove: (memberId, signal) => call(R.removeMember, { params: { memberId } }, signal),
            listInvites: (query, signal) => call(R.listInvites, { query }, signal),
            createInvite: (body, signal) => call(R.createInvite, { body }, signal),
            revokeInvite: (inviteId, signal) => call(R.revokeInvite, { params: { inviteId } }, signal),
            listAccessRequests: (query, signal) => call(R.listAccessRequests, { query }, signal),
            approveAccessRequest: (accessRequestId, body, signal) =>
                call(R.approveAccessRequest, { params: { accessRequestId }, body }, signal),
            declineAccessRequest: (accessRequestId, signal) =>
                call(R.declineAccessRequest, { params: { accessRequestId } }, signal),
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
            setDashboardRemovals: (body, signal) => call(R.setDashboardRemovals, { body }, signal),
        },
        passkeys: {
            list: (query, signal) => call(R.listPasskeys, { query }, signal),
            revoke: (passkeyId, signal) => call(R.revokePasskey, { params: { passkeyId } }, signal),
        },
        sessions: {
            list: (query, signal) => call(R.listSessions, { query }, signal),
            revoke: (sessionId, signal) => call(R.revokeSession, { params: { sessionId } }, signal),
        },
        wallet: {
            get: (signal) => call(R.getWallet, {}, signal),
            add: (body, signal) => call(R.addWalletRecord, { body }, signal),
            update: (recordId, body, signal) => call(R.updateWalletRecord, { params: { recordId }, body }, signal),
            delete: (recordId, signal) => call(R.deleteWalletRecord, { params: { recordId } }, signal),
            markSeen: (requestId, body, signal) =>
                call(R.markWalletRequestSeen, { params: { requestId }, body }, signal),
            reject: (requestId, body, signal) => call(R.rejectWalletRequest, { params: { requestId }, body }, signal),
        },
        browser: {
            openSignIn: (body, signal) => call(R.openBrowserSignIn, { body }, signal),
            listTabs: (query, signal) => call(R.listBrowserTabs, { query }, signal),
            watch: (tabId, signal) => call(R.watchBrowserTab, { params: { tabId } }, signal),
            control: (tabId, signal) => call(R.controlBrowserTab, { params: { tabId } }, signal),
            getSession: (sessionId, signal) => call(R.getBrowserSession, { params: { sessionId } }, signal),
            takeControl: (sessionId, signal) => call(R.takeBrowserControl, { params: { sessionId } }, signal),
            handBack: (sessionId, signal) => call(R.handBackBrowserTab, { params: { sessionId } }, signal),
            end: (sessionId, signal) => call(R.endBrowserSession, { params: { sessionId } }, signal),
            listHelpRequests: (query, signal) => call(R.listBrowserHelpRequests, { query }, signal),
            getHelpRequest: (requestId, signal) => call(R.getBrowserHelpRequest, { params: { requestId } }, signal),
            dismissHelpRequest: (requestId, signal) =>
                call(R.dismissBrowserHelpRequest, { params: { requestId } }, signal),
        },
        files: {
            list: (query, signal) => call(R.listFiles, { query }, signal),
            stats: (query, signal) => call(R.getFileStats, { query }, signal),
            uploadPolicy: (query, signal) => call(R.getFileUploadPolicy, { query }, signal),
            upload: (body, signal, options = {}) => call(R.uploadFile, { body }, signal, options.onProgress),
            get: (fileId, signal) => call(R.getFile, { params: { fileId } }, signal),
            listVersions: (fileId, query, signal) => call(R.listFileVersions, { params: { fileId }, query }, signal),
            download: (fileId, query, signal) => call(R.downloadFile, { params: { fileId }, query }, signal),
            delete: (fileId, signal) => call(R.deleteFile, { params: { fileId } }, signal),
        },
        runs: {
            list: (query, signal) => call(R.listRuns, { query }, signal),
            stats: (query, signal) => call(R.getRunStats, { query }, signal),
            get: (runId, signal) => call(R.getRun, { params: { runId } }, signal),
            cancel: (runId, signal) => call(R.cancelRun, { params: { runId } }, signal),
            retry: (runId, signal) => call(R.retryRun, { params: { runId } }, signal),
        },
        tasks: {
            list: (query, signal) => call(R.listTasks, { query }, signal),
            get: (taskId, signal) => call(R.getTask, { params: { taskId } }, signal),
            listOccurrences: (taskId, query, signal) =>
                call(R.listTaskOccurrences, { params: { taskId }, query }, signal),
        },
        testChat: {
            stream: (agentId, body, signal) => call(R.testAgentDraft, { params: { agentId }, body }, signal),
        },
        triggers: {
            list: (query, signal) => call(R.listTriggers, { query }, signal),
            stats: (query, signal) => call(R.getTriggerStats, { query }, signal),
            create: (body, signal) => call(R.createTrigger, { body }, signal),
            get: (triggerId, signal) => call(R.getTrigger, { params: { triggerId } }, signal),
            update: (triggerId, body, signal) => call(R.updateTrigger, { params: { triggerId }, body }, signal),
            delete: (triggerId, signal) => call(R.deleteTrigger, { params: { triggerId } }, signal),
            pause: (triggerId, signal) => call(R.pauseTrigger, { params: { triggerId } }, signal),
            resume: (triggerId, signal) => call(R.resumeTrigger, { params: { triggerId } }, signal),
            listFires: (triggerId, query, signal) => call(R.listTriggerFires, { params: { triggerId }, query }, signal),
        },
        integrations: {
            list: (query, signal) => call(R.listIntegrations, { query }, signal),
            stats: (query, signal) => call(R.getIntegrationStats, { query }, signal),
            create: (body, signal) => call(R.createIntegration, { body }, signal),
            connectCalendar: (body, signal) => call(R.connectCalendar, { body }, signal),
            get: (integrationId, signal) => call(R.getIntegration, { params: { integrationId } }, signal),
            update: (integrationId, body, signal) =>
                call(R.updateIntegration, { params: { integrationId }, body }, signal),
            delete: (integrationId, signal) => call(R.deleteIntegration, { params: { integrationId } }, signal),
            enable: (integrationId, signal) => call(R.enableIntegration, { params: { integrationId } }, signal),
            disable: (integrationId, signal) => call(R.disableIntegration, { params: { integrationId } }, signal),
            check: (integrationId, signal) => call(R.checkIntegration, { params: { integrationId } }, signal),
        },
        onboarding: {
            get: (signal) => call(R.getOnboarding, {}, signal),
            answer: (body, signal) => call(R.answerOnboarding, { body }, signal),
            defer: (signal) => call(R.deferOnboarding, {}, signal),
        },
        voice: {
            transcribe: (chatId, clip, query, signal) =>
                call(R.transcribeVoiceClip, { params: { chatId }, query, body: clip }, signal),
            speak: (chatId, messageId, body, signal) =>
                call(R.speakChatMessage, { params: { chatId, messageId }, body }, signal),
        },
        aiTools: {
            list: (signal) => call(R.listAiTools, {}, signal),
            get: (aiToolId, signal) => call(R.getAiTool, { params: { aiToolId } }, signal),
            check: (aiToolId, signal) => call(R.checkAiTool, { params: { aiToolId } }, signal),
            startSignIn: (aiToolId, body, signal) => call(R.startAiToolSignIn, { params: { aiToolId }, body }, signal),
            getSignIn: (aiToolId, signInId, signal) =>
                call(R.getAiToolSignIn, { params: { aiToolId, signInId } }, signal),
            answerSignIn: (aiToolId, signInId, body, signal) =>
                call(R.answerAiToolSignIn, { params: { aiToolId, signInId }, body }, signal),
            cancelSignIn: (aiToolId, signInId, signal) =>
                call(R.cancelAiToolSignIn, { params: { aiToolId, signInId } }, signal),
            signOut: (aiToolId, signal) => call(R.signOutAiTool, { params: { aiToolId } }, signal),
        },
        activity: {
            list: (query, signal) => call(R.listActivity, { query }, signal),
        },
        security: { get: (signal) => call(R.getSecurityOverview, {}, signal) },
        updates: { checkUi: (signal) => call(R.checkForUiUpdate, {}, signal) },
        audit: {
            list: (query, signal) => call(R.listAuditEntries, { query }, signal),
            verify: (signal) => call(R.verifyAuditLog, {}, signal),
        },
    };
}

function streamRequest(options: StreamOptions): { readonly lastEventId?: string } {
    return options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId };
}
