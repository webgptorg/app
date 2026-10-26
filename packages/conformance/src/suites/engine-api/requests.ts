import { ENGINE_API_ROUTES } from '@ptbk/engine-api';
import type { EngineApiRouteId, RouteDefinition } from '@ptbk/engine-api';

import { CHAT_MESSAGE, validBook } from '../../fixtures/books';
import { randomToken } from '../../random';
import type { ApiRequest } from './api';
import type { World } from './world';

const R = ENGINE_API_ROUTES;
const DAY_MS = 24 * 3600 * 1000;

type BodyBuilder = (world: World) => Promise<unknown>;

/**
 * A valid body for every committed route that takes one, built from the world's resources and changing nothing
 * visible where the route allows it (a rename to the same name), so a check can add exactly one defect to it.
 */
const BODIES: Partial<Record<EngineApiRouteId, BodyBuilder>> = {
    createAgent: (world) => Promise.resolve({ source: validBook(world.name('agent')) }),
    validateAgentSource: (world) => Promise.resolve({ source: validBook(world.name('agent')) }),
    updateAgent: async (world) => ({ visibility: (await world.agent()).visibility }),
    updateAgentSource: async (world) => {
        const agent = await world.agent();
        const source = await world.owner.ok(R.getAgentSource, { params: { agentId: agent.id } });
        return { source: source.source, baseRevisionId: source.revisionId };
    },
    createFolder: (world) => Promise.resolve({ name: world.name('folder') }),
    renameFolder: async (world) => ({ name: (await world.folder()).name }),
    createChat: (world) => Promise.resolve({ title: world.name('chat') }),
    sendChatMessage: () => Promise.resolve({ content: CHAT_MESSAGE }),
    createApiToken: (world) =>
        Promise.resolve({
            name: world.name('token'),
            permissions: ['agents.read'],
            expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
        }),
    updateSettings: () => Promise.resolve({}),
    setUpdatePolicy: async (world) => {
        const { updatePolicy } = await world.owner.ok(R.getSettings);
        return updatePolicy.policy === 'pinned' && updatePolicy.pinnedVersion !== null
            ? { policy: 'pinned', pinnedVersion: updatePolicy.pinnedVersion }
            : { policy: updatePolicy.policy === 'pinned' ? 'manual' : updatePolicy.policy };
    },
    createSecret: (world) =>
        Promise.resolve({
            name: world.name('secret'),
            scope: { kind: 'engine' },
            value: randomToken(world.ctx.random, 32),
        }),
    replaceSecretValue: (world) => Promise.resolve({ value: randomToken(world.ctx.random, 32) }),
    uploadFile: (world) => {
        const form = new FormData();
        form.set('file', new Blob(['synthetic conformance file\n'], { type: 'text/plain' }), 'conformance.txt');
        form.set('name', `${world.name('file')}.txt`);
        form.set('purpose', 'upload');
        return Promise.resolve(form);
    },
    createTrigger: async (world) => ({
        kind: 'schedule',
        agentId: (await world.agent()).id,
        name: world.name('trigger'),
        recurrence: { kind: 'once', at: new Date(Date.now() + 365 * DAY_MS).toISOString() },
        message: CHAT_MESSAGE,
    }),
    updateTrigger: async (world) => {
        const params = await world.paramsFor(R.getTrigger);
        if (params === null) return null;
        return { name: (await world.owner.ok(R.getTrigger, { params })).name };
    },
    createIntegration: (world) =>
        Promise.resolve({
            kind: 'mcp-server',
            name: world.name('integration'),
            url: 'https://mcp.conformance.invalid/',
        }),
    testAgentDraft: (world) =>
        Promise.resolve({ book: validBook(world.name('draft')), messages: [{ role: 'user', content: CHAT_MESSAGE }] }),
    updateIntegration: async (world) => {
        const params = await world.paramsFor(R.getIntegration);
        if (params === null) return null;
        return { name: (await world.owner.ok(R.getIntegration, { params })).name };
    },
};

/**
 * A valid body for the route even when the world cannot name its resources (e.g. an unadvertised capability), so
 * the engine never refuses it for its media type or shape before it gets to the point a check is about.
 */
export async function plausibleBody(route: RouteDefinition, world: World): Promise<unknown> {
    if (route.body === undefined) return undefined;
    const body = await BODIES[route.id as EngineApiRouteId]?.(world);
    if (body !== undefined && body !== null) return body;
    return route.body.kind === 'multipart' ? new FormData() : {};
}

/** Placeholder IDs with a plausible body, for routes the world has no resources for. */
export async function placeholderRequest(route: RouteDefinition, world: World | null): Promise<ApiRequest> {
    const params = Object.fromEntries(Object.keys(route.params?.shape ?? {}).map((name) => [name, PLACEHOLDER_ID]));
    const body =
        world === null
            ? route.body === undefined
                ? undefined
                : route.body.kind === 'multipart'
                  ? new FormData()
                  : {}
            : await plausibleBody(route, world);
    return { params, ...(body === undefined ? {} : { body }) };
}

/** Names nothing on any engine: the run ID is not part of it, so the suite never needs to create it. */
export const PLACEHOLDER_ID = 'conformance-nonexistent';

/** Query parameters a route cannot be called without; every other query parameter is optional. */
const REQUIRED_QUERIES: Partial<Record<EngineApiRouteId, Readonly<Record<string, string>>>> = {
    getFileUploadPolicy: { purpose: 'knowledge' },
};

/** The route's required query, if it has one, ready to spread into a request. */
export function requiredQuery(route: RouteDefinition): { readonly query?: Readonly<Record<string, string>> } {
    const query = REQUIRED_QUERIES[route.id as EngineApiRouteId];
    return query === undefined ? {} : { query };
}

/** A request the owner could send successfully, or `null` when the world has nothing for its parameters. */
export async function validRequest(route: RouteDefinition, world: World): Promise<ApiRequest | null> {
    const params = await world.paramsFor(route);
    if (params === null) return null;
    if (route.body === undefined) return { params, ...requiredQuery(route) };
    const build = BODIES[route.id as EngineApiRouteId];
    if (build === undefined) return null;
    const body = await build(world);
    return body === null ? null : { params, body };
}

/** The same body with one field the contract does not declare. */
export function withUnknownField(body: unknown): unknown {
    if (body instanceof FormData) {
        const copy = new FormData();
        for (const [key, value] of body) copy.append(key, value);
        copy.set('conformanceUnknownField', 'x');
        return copy;
    }
    return { ...(body as Record<string, unknown>), conformanceUnknownField: true };
}

export function hasBody(route: RouteDefinition): boolean {
    return route.body !== undefined;
}
