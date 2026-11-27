import { ENGINE_API_ROUTES } from '@ptbk/engine-api';
import type { EngineApiRouteId, RouteDefinition } from '@ptbk/engine-api';

import type { ApiRequest, EngineApi } from './api';
import { walkPages } from './support';

const R = ENGINE_API_ROUTES;

/** An owner read of whatever a route would change; equal snapshots before and after mean nothing changed. */
type Probe = (owner: EngineApi, request: ApiRequest) => Promise<unknown>;

const param = (request: ApiRequest, name: string): string => request.params?.[name] ?? '';
const bodyField = (request: ApiRequest, name: string): string => {
    const body = request.body as Readonly<Record<string, unknown>> | undefined;
    const value = body instanceof FormData ? body.get(name) : body?.[name];
    return typeof value === 'string' ? value : '';
};
const firstLine = (text: string): string => text.split('\n', 1)[0] ?? '';

const all = async (owner: EngineApi, route: RouteDefinition, query: Readonly<Record<string, string>> = {}) =>
    (await walkPages(owner, route, { ...query, limit: 100 }, 20)).pages.flat();
const ids = async (owner: EngineApi, route: RouteDefinition, query: Readonly<Record<string, string>> = {}) =>
    ((await all(owner, route, query)) as { readonly id: string }[]).map(({ id }) => id).sort();

const agent: Probe = async (owner, request) => {
    const params = { agentId: param(request, 'agentId') };
    return [await owner.ok(R.getAgent, { params }), await owner.ok(R.getAgentSource, { params })];
};
/** A test run stores nothing: the saved book, its revisions and the agent's chats stay as they were. */
const testRun: Probe = async (owner, request) => {
    const params = { agentId: param(request, 'agentId') };
    return [
        await owner.ok(R.getAgentSource, { params }),
        (await owner.ok(R.listAgentRevisions, { params, query: { limit: 100 } })).items,
        (await owner.ok(R.listAgentChats, { params, query: { limit: 100 } })).items,
    ];
};
const folders: Probe = (owner) => all(owner, R.listFolders);
const chatMessages: Probe = async (owner, request) =>
    (await owner.ok(R.listChatEntries, { params: { chatId: param(request, 'chatId') }, query: { limit: 100 } })).items;
const readState: Probe = async (owner, request) => {
    const { unread, questions } = await owner.ok(R.getChat, { params: { chatId: param(request, 'chatId') } });
    return { unread, questions };
};
const recheck: Probe = async (owner, request) =>
    (await owner.ok(R.getChat, { params: { chatId: param(request, 'chatId') } })).recheck;
const apiTokens: Probe = (owner) => all(owner, R.listApiTokens);
const settings: Probe = (owner) => owner.ok(R.getSettings);
const walletRecords: Probe = async (owner) => (await owner.ok(R.getWallet)).records;
const walletRequests: Probe = async (owner) => (await owner.ok(R.getWallet)).pending;
// Runs, triggers, files and integrations also change on their own (progress, firing, scanning), so their probes
// compare only what the refused request would have changed.
const run: Probe = async (owner, request) =>
    (await owner.ok(R.getRun, { params: { runId: param(request, 'runId') } })).cancelRequestedAt;
const retries: Probe = async (owner, request) =>
    ((await all(owner, R.listRuns)) as { readonly id: string; readonly retryOf: string | null }[])
        .filter(({ retryOf }) => retryOf === param(request, 'runId'))
        .map(({ id }) => id);
const trigger: Probe = async (owner, request) => {
    const { name, lifecycle, endedReason } = await owner.ok(R.getTrigger, {
        params: { triggerId: param(request, 'triggerId') },
    });
    return { name, lifecycle, endedReason };
};
const integration: Probe = async (owner, request) => {
    const { name, config, status } = await owner.ok(R.getIntegration, {
        params: { integrationId: param(request, 'integrationId') },
    });
    return { name, config, status };
};

/** Only the credentials: a check or the engine's own monitoring may move `checkedAt` and the status meanwhile. */
const aiTool: Probe = async (owner, request) =>
    (await owner.ok(R.getAiTool, { params: { aiToolId: param(request, 'aiToolId') } })).auth;

const PROBES: Partial<Record<EngineApiRouteId, Probe>> = {
    createAgent: (owner, request) =>
        ids(owner, R.listAgents, { q: firstLine(bodyField(request, 'source')), deleted: 'include' }),
    updateAgent: agent,
    deleteAgent: agent,
    restoreAgent: agent,
    updateAgentSource: agent,
    testAgentDraft: testRun,
    createFolder: folders,
    renameFolder: folders,
    deleteFolder: folders,
    createChat: (owner) => ids(owner, R.listChats, { q: 'conformance-' }),
    sendChatMessage: chatMessages,
    cancelChatReply: chatMessages,
    retryChatReply: recheck,
    markChatRead: readState,
    markChatSeen: readState,
    createApiToken: apiTokens,
    revokeApiToken: apiTokens,
    updateSettings: settings,
    setUpdatePolicy: settings,
    // Sessions see `lastSeenAt` move with every request, so only which ones exist is compared.
    revokeSession: (owner) => ids(owner, R.listSessions),
    revokePasskey: (owner) => all(owner, R.listPasskeys),
    addWalletRecord: walletRecords,
    updateWalletRecord: walletRecords,
    deleteWalletRecord: walletRecords,
    markWalletRequestSeen: walletRequests,
    rejectWalletRequest: walletRequests,
    cancelRun: run,
    retryRun: retries,
    uploadFile: (owner, request) => ids(owner, R.listFiles, { q: bodyField(request, 'name') }),
    deleteFile: async (owner, request) =>
        (await owner.ok(R.getFile, { params: { fileId: param(request, 'fileId') } })).id,
    createTrigger: (owner) => ids(owner, R.listTriggers),
    updateTrigger: trigger,
    pauseTrigger: trigger,
    resumeTrigger: trigger,
    deleteTrigger: trigger,
    createIntegration: (owner) => ids(owner, R.listIntegrations),
    updateIntegration: integration,
    deleteIntegration: integration,
    enableIntegration: integration,
    disableIntegration: integration,
    startAiToolSignIn: aiTool,
    signOutAiTool: aiTool,
    checkIntegration: async (owner, request) =>
        (await owner.ok(R.getIntegration, { params: { integrationId: param(request, 'integrationId') } })).name,
};

/** A snapshot of what `route` would change, or `null` for routes that change nothing (validation). */
export async function snapshot(owner: EngineApi, route: RouteDefinition, request: ApiRequest): Promise<string | null> {
    const probe = PROBES[route.id as EngineApiRouteId];
    return probe === undefined ? null : JSON.stringify(await probe(owner, request));
}
