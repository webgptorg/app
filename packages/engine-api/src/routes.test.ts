import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES, RESERVED_CAPABILITIES } from './capabilities/capability';
import { isReadPermission } from './permissions';
import type { RouteDefinition } from './route';
import { ENGINE_API_ROUTES, ENGINE_API_ROUTE_LIST } from './routes';

/** Any signed-in member may call these; `/me/**` acts only on the caller's own resources. */
function isSelfService(route: RouteDefinition): boolean {
    return route.path === '/engine' || route.path === '/me' || route.path.startsWith('/me/');
}
const FORBIDDEN_RESPONSE_KEYS = new Set(['value', 'secret', 'token', 'password']);

function placeholders(path: string): string[] {
    return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '').sort();
}

function responseSchemas(route: RouteDefinition): z.ZodType[] {
    return Object.values(route.responses).flatMap((response) => {
        switch (response.kind) {
            case 'json':
                return [response.schema];
            case 'sse':
                return [response.event];
            case 'empty':
            case 'binary':
                return [];
        }
    });
}

/** Every property name anywhere in a JSON Schema, following properties, items, combinators and $defs. */
function propertyNames(node: unknown, names: Set<string>): Set<string> {
    if (Array.isArray(node)) {
        for (const item of node) propertyNames(item, names);
    } else if (typeof node === 'object' && node !== null) {
        for (const [key, value] of Object.entries(node as Readonly<Record<string, unknown>>)) {
            if (key === 'properties' && typeof value === 'object' && value !== null) {
                for (const name of Object.keys(value)) names.add(name);
            }
            propertyNames(value, names);
        }
    }
    return names;
}

function credentialKeys(route: RouteDefinition): string[] {
    const names = new Set<string>();
    for (const schema of responseSchemas(route)) {
        propertyNames(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }), names);
    }
    return [...names].filter((name) => FORBIDDEN_RESPONSE_KEYS.has(name.toLowerCase()));
}

function requestSchemas(route: RouteDefinition): z.ZodType[] {
    return [route.params, route.query, route.body?.schema].filter((schema) => schema !== undefined);
}

/** Request fields too: only the Wallet's writes take a credential; everything else references secrets by name. */
function requestCredentialKeys(route: RouteDefinition): string[] {
    const names = new Set<string>();
    for (const schema of requestSchemas(route)) {
        propertyNames(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), names);
    }
    return [...names].filter((name) => FORBIDDEN_RESPONSE_KEYS.has(name.toLowerCase()));
}

const CAPABILITY_BY_PATH = [
    ['/runs', KNOWN_CAPABILITIES.runs],
    ['/tasks', KNOWN_CAPABILITIES.tasks],
    ['/files', KNOWN_CAPABILITIES.files],
    ['/triggers', KNOWN_CAPABILITIES.triggers],
    ['/integrations', KNOWN_CAPABILITIES.integrations],
    ['/agents/{agentId}/test-chat', KNOWN_CAPABILITIES.testChat],
    ['/access-requests', KNOWN_CAPABILITIES.accessRequests],
    ['/settings/dashboard-removals', KNOWN_CAPABILITIES.accessRequests],
    ['/chats/{chatId}/live-audio', RESERVED_CAPABILITIES.liveAudio],
    ['/browser-tab-sessions', RESERVED_CAPABILITIES.browserTab],
    ['/onboarding', KNOWN_CAPABILITIES.onboarding],
    ['/wallet', KNOWN_CAPABILITIES.wallet],
] as const;

/** Core features an engine may leave out: these routes share paths with core routes that stay, so they go by ID. */
const CAPABILITY_BY_ROUTE: Readonly<Record<string, (typeof KNOWN_CAPABILITIES)[keyof typeof KNOWN_CAPABILITIES]>> = {
    updateMember: KNOWN_CAPABILITIES.members,
    removeMember: KNOWN_CAPABILITIES.members,
    listInvites: KNOWN_CAPABILITIES.members,
    createInvite: KNOWN_CAPABILITIES.members,
    revokeInvite: KNOWN_CAPABILITIES.members,
    listApiTokens: KNOWN_CAPABILITIES.apiTokens,
    createApiToken: KNOWN_CAPABILITIES.apiTokens,
    revokeApiToken: KNOWN_CAPABILITIES.apiTokens,
    listAuditEntries: KNOWN_CAPABILITIES.audit,
    verifyAuditLog: KNOWN_CAPABILITIES.audit,
    validateAgentSource: KNOWN_CAPABILITIES.bookEditor,
    updateAgentSource: KNOWN_CAPABILITIES.bookEditor,
    listAgentRevisions: KNOWN_CAPABILITIES.bookEditor,
    getAgentRevision: KNOWN_CAPABILITIES.bookEditor,
    updateAgent: KNOWN_CAPABILITIES.agentManagement,
    restoreAgent: KNOWN_CAPABILITIES.agentManagement,
};

function expectedCapability(route: RouteDefinition) {
    return (
        CAPABILITY_BY_ROUTE[route.id] ??
        CAPABILITY_BY_PATH.find(([prefix]) => route.path === prefix || route.path.startsWith(`${prefix}/`))?.[1]
    );
}

const capabilityRoutes = ENGINE_API_ROUTE_LIST.filter((route) => expectedCapability(route) !== undefined);

describe('ENGINE_API_ROUTES', () => {
    it('keys every route by its unique operation ID', () => {
        for (const [key, route] of Object.entries(ENGINE_API_ROUTES)) expect(route.id).toBe(key);
        expect(new Set(ENGINE_API_ROUTE_LIST.map((route) => route.id)).size).toBe(ENGINE_API_ROUTE_LIST.length);
    });

    it('has one route per method and path', () => {
        const keys = ENGINE_API_ROUTE_LIST.map((route) => `${route.method} ${route.path}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('declares exactly the path placeholders as params', () => {
        for (const route of ENGINE_API_ROUTE_LIST) {
            expect(Object.keys(route.params?.shape ?? {}).sort(), route.id).toEqual(placeholders(route.path));
        }
    });

    it('requires a permission on every route except /me, /me/** and /engine', () => {
        for (const route of ENGINE_API_ROUTE_LIST) {
            if (isSelfService(route)) expect(route.permission, route.id).toBeNull();
            else expect(route.permission, route.id).not.toBeNull();
        }
        expect(ENGINE_API_ROUTES.getMe.path).toBe('/me');
        expect(ENGINE_API_ROUTES.getEngine.path).toBe('/engine');
    });

    it('documents that self-service credential routes answer 404 for anyone else', () => {
        for (const route of [ENGINE_API_ROUTES.revokeMyPasskey, ENGINE_API_ROUTES.revokeMySession]) {
            expect(route.description, route.id).toContain('404');
        }
        expect(ENGINE_API_ROUTES.revokeMyPasskey.stepUp).toBe(true);
        expect(ENGINE_API_ROUTES.revokeMyPasskey.problems).toContain('last-passkey');
        expect(ENGINE_API_ROUTES.revokePasskey.permission).toBe('members.manage');
        expect(ENGINE_API_ROUTES.revokeSession.permission).toBe('members.manage');
        expect(ENGINE_API_ROUTES.listPasskeys.permission).toBe('security.read');
        expect(ENGINE_API_ROUTES.listSessions.permission).toBe('security.read');
    });

    it('requires a non-read permission on every mutating route outside /me/**', () => {
        // Recording what the caller read or saw changes no content: anyone who may read a thread may record it.
        const readMarkers: ReadonlySet<string> = new Set(['markChatRead', 'markChatSeen']);
        for (const route of ENGINE_API_ROUTE_LIST.filter((candidate) => candidate.method !== 'GET')) {
            if (isSelfService(route)) continue;
            expect(route.permission, route.id).not.toBeNull();
            if (route.permission === null) continue;
            expect(isReadPermission(route.permission), route.id).toBe(readMarkers.has(route.id));
        }
    });

    it('declares exactly one success response', () => {
        for (const route of ENGINE_API_ROUTE_LIST) expect(Object.keys(route.responses), route.id).toHaveLength(1);
    });

    it('sends a body only with non-GET requests', () => {
        for (const route of ENGINE_API_ROUTE_LIST.filter((candidate) => candidate.body)) {
            expect(route.method, route.id).not.toBe('GET');
        }
    });

    it('requires step-up for the update policy, API token creation, passkey revocation and Wallet login writes', () => {
        expect(ENGINE_API_ROUTES.setUpdatePolicy.stepUp).toBe(true);
        expect(ENGINE_API_ROUTES.createApiToken.stepUp).toBe(true);
        expect(ENGINE_API_ROUTES.revokePasskey.stepUp).toBe(true);
        for (const route of [
            ENGINE_API_ROUTES.addWalletRecord,
            ENGINE_API_ROUTES.updateWalletRecord,
            ENGINE_API_ROUTES.deleteWalletRecord,
        ]) {
            expect(route.stepUp, route.id).toBe(true);
        }
        expect(ENGINE_API_ROUTES.markWalletRequestSeen).not.toHaveProperty('stepUp');
        expect(ENGINE_API_ROUTES.rejectWalletRequest).not.toHaveProperty('stepUp');
    });

    it('never returns a value, secret or token field, except the new token from POST /api-tokens', () => {
        for (const route of ENGINE_API_ROUTE_LIST.filter((candidate) => candidate.id !== 'createApiToken')) {
            expect(credentialKeys(route), route.id).toEqual([]);
        }
        expect(credentialKeys(ENGINE_API_ROUTES.createApiToken)).toEqual(['token']);
    });
});

describe('capability routes', () => {
    it('covers every capability', () => {
        const covered = new Set(capabilityRoutes.map((route) => route.capability?.id));
        // `file-scanning` adds no route: it changes what `files@1` reports; `live-video` will extend live audio.
        expect([...covered].sort()).toEqual(
            [...Object.values(KNOWN_CAPABILITIES), ...Object.values(RESERVED_CAPABILITIES)]
                .filter((ref) => ref !== KNOWN_CAPABILITIES.fileScanning && ref !== RESERVED_CAPABILITIES.liveVideo)
                .map(({ id }) => id)
                .sort(),
        );
    });

    it('declares its capability and a permission on every route of a capability', () => {
        for (const route of capabilityRoutes) {
            expect(route.capability, route.id).toEqual(expectedCapability(route));
            expect(route.permission, route.id).not.toBeNull();
        }
    });

    it('declares no capability on core routes', () => {
        for (const route of ENGINE_API_ROUTE_LIST.filter((candidate) => !expectedCapability(candidate))) {
            expect(route.capability, route.id).toBeUndefined();
        }
        const core: readonly RouteDefinition[] = [ENGINE_API_ROUTES.listActivity, ENGINE_API_ROUTES.streamEvents];
        for (const route of core) expect(route.capability, route.id).toBeUndefined();
    });

    it('requires a non-read permission on every mutating capability route', () => {
        for (const route of capabilityRoutes.filter((candidate) => candidate.method !== 'GET')) {
            expect(route.permission, route.id).not.toBeNull();
            if (route.permission !== null) expect(isReadPermission(route.permission), route.id).toBe(false);
        }
        expect(ENGINE_API_ROUTES.cancelRun.permission).toBe('runs.control');
        expect(ENGINE_API_ROUTES.retryRun.permission).toBe('runs.control');
        expect(ENGINE_API_ROUTES.pauseTrigger.permission).toBe('triggers.manage');
        expect(ENGINE_API_ROUTES.checkIntegration.permission).toBe('integrations.manage');
    });

    it('takes a credential only in Wallet writes and a secret setup answer, and returns none but the new API token', () => {
        const walletWrites: readonly RouteDefinition[] = [
            ENGINE_API_ROUTES.addWalletRecord,
            ENGINE_API_ROUTES.updateWalletRecord,
        ];
        const takesCredential: readonly RouteDefinition[] = [...walletWrites, ENGINE_API_ROUTES.answerOnboarding];
        for (const route of capabilityRoutes.filter((candidate) => candidate.id !== 'createApiToken')) {
            expect(credentialKeys(route), route.id).toEqual([]);
            if (!takesCredential.includes(route)) expect(requestCredentialKeys(route), route.id).toEqual([]);
        }
        for (const route of walletWrites) expect(requestCredentialKeys(route).sort()).toEqual(['password', 'value']);
        expect(requestCredentialKeys(ENGINE_API_ROUTES.answerOnboarding)).toEqual(['value']);
    });

    it('lists chats across agents with chats.read and filters activity per item', () => {
        expect(ENGINE_API_ROUTES.listChats).toMatchObject({ path: '/chats', permission: 'chats.read' });
        expect(ENGINE_API_ROUTES.listActivity).toMatchObject({ path: '/activity', permission: 'agents.read' });
    });
});
