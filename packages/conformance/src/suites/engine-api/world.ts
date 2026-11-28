import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES, supports, supportsRoute } from '@ptbk/engine-api';
import type {
    Agent,
    ApiToken,
    Chat,
    EngineApiRouteId,
    EngineInfo,
    Folder,
    Me,
    Message,
    Permission,
    RouteDefinition,
    WalletRecord,
} from '@ptbk/engine-api';

import type { CheckContext } from '../../check';
import { fail, skip } from '../../check';
import { CHAT_MESSAGE, validBook } from '../../fixtures/books';
import { randomToken } from '../../random';
import type { SessionSubject } from '../../target';
import { EngineApi } from './api';

const R = ENGINE_API_ROUTES;

/** How long the suite waits for an agent's reply to complete. */
export const REPLY_TIMEOUT_MS = 45_000;

export interface Reply {
    readonly userMessage: Message;
    readonly replyMessageId: string;
}

const REPLY_POLL_MS = 250;

/**
 * The first agent reply after `sentId`, skipping `progress` updates: replies are entries of their own, which the engine
 * may add a moment after the send is acknowledged. Fails after `REPLY_TIMEOUT_MS`.
 */
export async function replyAfter(api: EngineApi, chatId: string, sentId: string): Promise<Message> {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    for (;;) {
        const { items } = await api.ok(R.listChatEntries, { params: { chatId }, query: { limit: 100 } });
        const sentAt = items.findIndex(({ id }) => id === sentId);
        const after = sentAt === -1 ? [] : items.slice(0, sentAt).reverse();
        const reply = after.find(
            (entry): entry is Message =>
                entry.type === 'message' && entry.author.kind === 'agent' && entry.phase !== 'progress',
        );
        if (reply) return reply;
        if (Date.now() > deadline) fail(`no agent answered within ${String(REPLY_TIMEOUT_MS)} ms`);
        await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_MS));
    }
}

/**
 * The resources a check works on, created by the owner on first use and removed after the check. Everything the
 * suite creates is named `conformance-<runId>-…`.
 */
export interface World {
    readonly ctx: CheckContext;
    readonly owner: EngineApi;
    name(label: string): string;
    me(): Promise<Me>;
    engine(): Promise<EngineInfo>;
    advertises(route: RouteDefinition): Promise<boolean>;
    agent(): Promise<Agent>;
    createAgent(label: string, api?: EngineApi): Promise<Agent>;
    chat(): Promise<Chat>;
    /** A message sent to `chat()` whose reply has finished. */
    reply(): Promise<Reply>;
    folder(): Promise<Folder>;
    createFolder(label: string): Promise<Folder>;
    /**
     * A Wallet login on an origin of its own (`https://<label>-<n>.<runId>.conformance.invalid`), removed after the
     * check. `null` without `wallet@1`, when the Wallet is not `ready`, or when the engine wants a fresh step-up the
     * suite cannot give.
     */
    walletLogin(): Promise<WalletRecord | null>;
    createWalletLogin(label: string, password: string, fieldValue?: string): Promise<WalletRecord | null>;
    /** `null` when the engine wants a fresh step-up the suite cannot give. */
    apiToken(): Promise<ApiToken | null>;
    /** Values for the route's path parameters, or `null` when the engine has nothing to name. */
    paramsFor(route: RouteDefinition): Promise<Readonly<Record<string, string>> | null>;
}

/** A session for a subject, or a skip when the target cannot provide one. */
export async function sessionFor(ctx: CheckContext, subject: SessionSubject, why: string): Promise<EngineApi> {
    const credential = await ctx.target.session(subject);
    if (credential === null) {
        skip(`the target provides no ${subject.kind === 'owner' ? 'owner' : 'member'} session (${why})`);
    }
    return new EngineApi(ctx, credential);
}

export function allPermissionsExcept(permission: Permission | null, all: readonly Permission[]): Permission[] {
    return all.filter((candidate) => candidate !== permission);
}

/** By default the owner creates everything; `api` makes another member the creator. */
export async function createWorld(ctx: CheckContext, api?: EngineApi): Promise<World> {
    const owner = api ?? (await sessionFor(ctx, { kind: 'owner' }, 'the checks act as the owner'));
    let counter = 0;
    const memo = <T>(make: () => Promise<T>): (() => Promise<T>) => {
        let value: Promise<T> | undefined;
        return () => (value ??= make());
    };
    const cleanupApi = (signal: AbortSignal): EngineApi => owner.withSignal(signal);

    const name = (label: string): string => `conformance-${ctx.runId}-${label}-${String(++counter)}`;
    const me = memo(() => owner.ok(R.getMe));
    const engine = memo(() => owner.ok(R.getEngine));

    async function createAgent(label: string, api: EngineApi = owner): Promise<Agent> {
        const agent = await api.ok(R.createAgent, { body: { source: validBook(name(label)) } });
        ctx.resources.defer((signal) => cleanupApi(signal).send(R.deleteAgent, { params: { agentId: agent.id } }));
        return agent;
    }
    async function createFolder(label: string): Promise<Folder> {
        const folder = await owner.ok(R.createFolder, { body: { name: name(label) } });
        ctx.resources.defer((signal) => cleanupApi(signal).send(R.deleteFolder, { params: { folderId: folder.id } }));
        return folder;
    }
    async function createWalletLogin(label: string, password: string, fieldValue?: string) {
        if (!supports(await engine(), KNOWN_CAPABILITIES.wallet)) return null;
        if ((await owner.ok(R.getWallet)).state !== 'ready') return null;
        const result = await owner.call(R.addWalletRecord, {
            body: {
                origin: `https://${label}-${String(++counter)}.${ctx.runId}.conformance.invalid`,
                username: name(label),
                password,
                ...(fieldValue === undefined ? {} : { fields: [{ label: 'Security answer', value: fieldValue }] }),
            },
        });
        if (result.kind === 'problem') {
            if (result.problem.code === 'step-up-required') return null;
            fail(`POST /wallet/records: expected success, got ${String(result.status)} ${result.problem.code}`);
        }
        const { record } = result.data;
        ctx.resources.defer((signal) =>
            cleanupApi(signal).send(R.deleteWalletRecord, { params: { recordId: record.id } }),
        );
        return record;
    }

    const agent = memo(() => createAgent('agent'));
    const chat = memo(async () => {
        const { id } = await agent();
        return owner.ok(R.createChat, { body: { agentId: id, title: name('chat') } });
    });
    const reply = memo(async (): Promise<Reply> => {
        const { id: chatId } = await chat();
        const sent = await owner.ok(R.sendChatMessage, { params: { chatId }, body: { content: CHAT_MESSAGE } });
        const reply = await replyAfter(owner, chatId, sent.message.id);
        if (reply.status === 'streaming') {
            const stream = await owner.stream(
                R.streamChatReply,
                { params: { chatId, messageId: reply.id } },
                { maxMs: REPLY_TIMEOUT_MS, until: ({ event }) => event.type !== 'delta' },
            );
            if (!stream.items.some(({ event }) => event.type === 'completed' || event.type === 'failed')) {
                fail(`the reply did not finish within ${String(REPLY_TIMEOUT_MS)} ms`);
            }
        }
        return { userMessage: sent.message, replyMessageId: reply.id };
    });
    const folder = memo(() => createFolder('folder'));
    const walletLogin = memo(() => createWalletLogin('login', randomToken(ctx.random, 32)));
    const walletRequest = memo(async () => {
        if (!(await advertises(R.getWallet))) return null;
        return (await owner.ok(R.getWallet)).pending[0]?.id ?? null;
    });
    const apiToken = memo(async () => {
        if (!(await advertises(R.createApiToken))) return null;
        const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        const result = await owner.call(R.createApiToken, {
            body: { name: name('token'), permissions: ['agents.read'], expiresAt },
        });
        if (result.kind === 'problem') {
            if (result.problem.code === 'step-up-required') return null;
            fail(`POST /api-tokens: expected success, got ${String(result.status)} ${result.problem.code}`);
        }
        const { apiToken: token } = result.data;
        ctx.resources.defer((signal) =>
            cleanupApi(signal).send(R.revokeApiToken, { params: { apiTokenId: token.id } }),
        );
        return token;
    });
    const advertises = async (route: RouteDefinition): Promise<boolean> =>
        route.capability === undefined || supportsRoute(await engine(), route);

    const firstItem = async (route: RouteDefinition, query: Readonly<Record<string, string>> = {}) => {
        if (!(await advertises(route))) return null;
        const page = (await owner.ok(route, { query })) as { readonly items: readonly { readonly id: string }[] };
        return page.items[0]?.id ?? null;
    };
    const ownSession = memo(async () => {
        const page = await owner.ok(R.listMySessions);
        return (page.items.find((session) => !session.current) ?? page.items[0])?.id ?? null;
    });
    const ownPasskey = memo(async () => (await owner.ok(R.listMyPasskeys)).items[0]?.id ?? null);
    const run = memo(() => firstItem(R.listRuns));
    const task = memo(() => firstItem(R.listTasks));
    const file = memo(async () => {
        if (!(await advertises(R.uploadFile))) return null;
        const form = new FormData();
        form.set('file', new Blob(['synthetic conformance file\n'], { type: 'text/plain' }), 'conformance.txt');
        form.set('name', `${name('file')}.txt`);
        form.set('purpose', 'upload');
        const uploaded = await owner.ok(R.uploadFile, { body: form });
        ctx.resources.defer((signal) => cleanupApi(signal).send(R.deleteFile, { params: { fileId: uploaded.id } }));
        return uploaded.id;
    });
    const trigger = memo(async () => {
        if (!(await advertises(R.createTrigger))) return null;
        const { id: agentId } = await agent();
        const created = await owner.ok(R.createTrigger, {
            body: {
                kind: 'schedule',
                agentId,
                name: name('trigger'),
                recurrence: { kind: 'once', at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() },
                message: CHAT_MESSAGE,
            },
        });
        ctx.resources.defer((signal) =>
            cleanupApi(signal).send(R.deleteTrigger, { params: { triggerId: created.id } }),
        );
        return created.id;
    });
    const integration = memo(async () => {
        if (!(await advertises(R.createIntegration))) return null;
        const created = await owner.ok(R.createIntegration, {
            body: { kind: 'mcp-server', name: name('integration'), url: 'https://mcp.conformance.invalid/' },
        });
        ctx.resources.defer((signal) =>
            cleanupApi(signal).send(R.deleteIntegration, { params: { integrationId: created.id } }),
        );
        return created.id;
    });

    // An installed tool when there is one, so a request for it reaches the point a check is about.
    const aiTool = memo(async () => {
        if (!(await advertises(R.listAiTools))) return null;
        const { items } = await owner.ok(R.listAiTools);
        return (items.find(({ status }) => status !== 'not-installed') ?? items[0])?.id ?? null;
    });

    const resolvers: Readonly<Record<string, () => Promise<string | null>>> = {
        agentId: async () => (await agent()).id,
        revisionId: async () => (await agent()).currentRevisionId,
        chatId: async () => (await chat()).id,
        messageId: async () => (await reply()).replyMessageId,
        folderId: async () => (await folder()).id,
        recordId: async () => (await walletLogin())?.id ?? null,
        requestId: walletRequest,
        memberId: async () => (await me()).memberId,
        passkeyId: ownPasskey,
        sessionId: ownSession,
        apiTokenId: async () => (await apiToken())?.id ?? null,
        runId: run,
        taskId: task,
        fileId: file,
        triggerId: trigger,
        integrationId: integration,
        aiToolId: aiTool,
    };

    return {
        ctx,
        owner,
        name,
        me,
        engine,
        advertises,
        agent,
        createAgent,
        chat,
        reply,
        folder,
        createFolder,
        walletLogin,
        createWalletLogin,
        apiToken,
        async paramsFor(route) {
            const params: Record<string, string> = {};
            for (const param of Object.keys(route.params?.shape ?? {})) {
                const resolve = resolvers[param];
                const value = resolve === undefined ? null : await resolve();
                if (value === null) return null;
                params[param] = value;
            }
            return params;
        },
    };
}

/** Routes the suite exercises: everything except `draft` ones, whose behaviour is not committed yet. */
export function committedRoutes(routes: readonly RouteDefinition[]): readonly RouteDefinition[] {
    return routes.filter((route) => route.draft !== true);
}

export function routeById(id: EngineApiRouteId): RouteDefinition {
    return ENGINE_API_ROUTES[id];
}
