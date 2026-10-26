import type { Permission, RouteDefinition } from '@ptbk/engine-api';
import { ENGINE_API_PREFIX, ENGINE_API_ROUTE_LIST, ENGINE_API_ROUTES } from '@ptbk/engine-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROLE_PERMISSIONS } from '../src/domain/authorization/policy';
import { SESSION_COOKIE_NAME } from '../src/domain/gateway/sessions';
import type { ApiHarness } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
const FUTURE = '2030-01-01T00:00:00Z';
let counter = 0;
const unique = (prefix: string): string => `${prefix} ${String(++counter)}`;

/** A body each route accepts, so the permission decides the answer rather than validation. */
function validBody(route: RouteDefinition): unknown {
    switch (route.id) {
        case 'createAgent':
            return { source: unique('Matrix agent') };
        case 'validateAgentSource':
            return { source: 'Matrix' };
        case 'updateAgent':
            return { visibility: 'private' };
        case 'updateAgentSource':
            return { source: 'Matrix', baseRevisionId: 'revision-unknown' };
        case 'createFolder':
            return { name: unique('Matrix folder') };
        case 'renameFolder':
            return { name: unique('Renamed') };
        case 'createChat':
            return { title: 'Matrix' };
        case 'sendChatMessage':
            return { content: 'hello' };
        case 'updateMember':
            return { role: 'viewer' };
        case 'createInvite':
            return { role: 'viewer', expiresAt: FUTURE };
        case 'createApiToken':
            return { name: unique('Matrix token'), permissions: ['agents.read'], expiresAt: FUTURE };
        case 'updateSettings':
            return { name: 'Matrix engine' };
        case 'setUpdatePolicy':
            return { policy: 'auto' };
        case 'createSecret':
            return { name: unique('MATRIX').replace(' ', '_'), scope: { kind: 'engine' }, value: 'matrix-value' };
        case 'replaceSecretValue':
            return { value: 'matrix-value-2' };
        case 'createTrigger':
            return {
                kind: 'schedule',
                agentId: 'agent-unknown',
                name: 'Matrix',
                recurrence: { kind: 'interval', everySeconds: 3600 },
                message: 'Run',
            };
        case 'updateTrigger':
        case 'updateIntegration':
            return { name: 'Matrix' };
        case 'createIntegration':
            return {
                kind: 'mcp-server',
                name: 'Matrix',
                agentId: null,
                url: 'https://mcp.example.com/',
                secretNames: [],
            };
        case 'connectCalendar':
            return { provider: 'google' };
        default:
            return undefined;
    }
}

/** Every path parameter names a resource nobody has, so an allowed call answers 404 and changes nothing. */
function pathOf(route: RouteDefinition, ids: Readonly<Record<string, string>> = {}): string {
    return `${ENGINE_API_PREFIX}${route.path.replace(/\{(\w+)\}/g, (_, name: string) => ids[name] ?? 'unknown-id')}`;
}

async function call(
    harness: ApiHarness,
    cookie: string,
    route: RouteDefinition,
    ids?: Readonly<Record<string, string>>,
    body: unknown = validBody(route),
): Promise<{ readonly status: number; readonly body: Record<string, unknown> | null }> {
    const init: RequestInit & { headers: Record<string, string> } = { method: route.method, headers: {} };
    if (route.body?.kind === 'json') {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
    } else if (route.body?.kind === 'multipart') {
        const form = new FormData();
        form.set('file', new Blob(['matrix']), 'matrix.txt');
        form.set('name', 'matrix.txt');
        form.set('purpose', 'upload');
        init.body = form;
    }
    const abort = new AbortController();
    init.signal = abort.signal;
    const response = await harness.fetch(cookie)(`${HARNESS_ORIGIN}${pathOf(route, ids)}`, init);
    const type = response.headers.get('content-type') ?? '';
    if (type.startsWith('text/event-stream')) {
        abort.abort();
        return { status: response.status, body: null };
    }
    const text = await response.text();
    return {
        status: response.status,
        body: type.includes('json') && text !== '' ? (JSON.parse(text) as Record<string, unknown>) : null,
    };
}

function expectDecision(
    route: RouteDefinition,
    permissions: ReadonlySet<Permission>,
    result: { readonly status: number; readonly body: Record<string, unknown> | null },
): void {
    const label = `${route.id} -> ${String(result.status)}`;
    if (route.permission === null || permissions.has(route.permission)) {
        expect(result.status, label).not.toBe(403);
        expect(result.status, label).not.toBe(401);
        return;
    }
    expect(result.status, label).toBe(403);
    expect(result.body, label).toMatchObject({ code: 'forbidden', requiredPermission: route.permission });
}

let harness: ApiHarness;
const memberOf = (role: (typeof ROLES)[number]): string => {
    const found = harness
        .core()
        .controller.inspect()
        .members.find((member) => member.role === role);
    if (found === undefined) throw new Error(`no ${role}`);
    return found.id;
};

beforeAll(async () => {
    harness = await createApiHarness({ rateLimiter: { consume: () => ({ kind: 'allowed' }) } });
});

afterAll(async () => {
    await harness.recorder.settled();
    expect(harness.recorder.violations).toEqual([]);
    await harness.close();
});

describe('authorisation matrix', () => {
    it.each(ROLES)('gives %s exactly the routes its role holds, capability routes included', async (role) => {
        const cookie = harness.signIn({ memberId: memberOf(role) });
        const permissions = new Set(ROLE_PERMISSIONS[role]);
        expect(ENGINE_API_ROUTE_LIST.filter((route) => route.capability !== undefined).length).toBeGreaterThan(25);
        for (const route of ENGINE_API_ROUTE_LIST)
            expectDecision(route, permissions, await call(harness, cookie, route));
    });

    it.each<[string, Permission[]]>([
        ['core reads', ['agents.read', 'secrets.read']],
        ['run control without reading triggers', ['agents.read', 'runs.read', 'runs.control', 'files.read']],
        [
            'trigger and integration managers',
            ['triggers.read', 'triggers.manage', 'integrations.manage', 'files.write'],
        ],
    ])(
        'allows a session with an explicit permission set (%s) exactly the routes whose permission is in it',
        async (_, set) => {
            const cookie = harness.signIn({ memberId: memberOf('admin'), permissions: set });
            for (const route of ENGINE_API_ROUTE_LIST)
                expectDecision(route, new Set(set), await call(harness, cookie, route));
        },
    );

    it('lets secrets.read list secret metadata but write nothing', async () => {
        const cookie = harness.signIn({ memberId: memberOf('member'), permissions: ['secrets.read'] });
        const listed = await call(harness, cookie, ENGINE_API_ROUTES.listSecrets);
        expect(listed.status).toBe(200);
        expect((listed.body?.['items'] as unknown[]).length).toBeGreaterThan(0);
        expect(JSON.stringify(listed.body)).not.toMatch(/"value"/);
        const [secret] = listed.body?.['items'] as { id: string }[];
        for (const route of [
            ENGINE_API_ROUTES.createSecret,
            ENGINE_API_ROUTES.replaceSecretValue,
            ENGINE_API_ROUTES.revokeSecret,
            ENGINE_API_ROUTES.deleteSecret,
        ]) {
            const result = await call(harness, cookie, route, { secretId: secret?.id ?? '' });
            expect(result.status, route.id).toBe(403);
            expect(result.body, route.id).toMatchObject({ code: 'forbidden', requiredPermission: 'secrets.manage' });
        }
    });

    it('gives a viewer 403 on every mutating route', async () => {
        const cookie = harness.signIn({ memberId: memberOf('viewer') });
        const mutating = ENGINE_API_ROUTE_LIST.filter(
            (route) => route.method !== 'GET' && route.capability === undefined && route.permission !== null,
        );
        expect(mutating.length).toBeGreaterThan(25);
        for (const route of mutating) {
            const result = await call(harness, cookie, route);
            expect(result.status, route.id).toBe(403);
            expect(result.body?.['code'], route.id).toBe('forbidden');
        }
    });
});

describe('order of checks', () => {
    it('answers a missing permission with 403 even when the input is invalid', async () => {
        const cookie = harness.signIn({ memberId: memberOf('viewer') });
        const denied = await call(harness, cookie, ENGINE_API_ROUTES.createSecret, {}, { surprise: true });
        expect(denied.status).toBe(403);
        expect(denied.body).toMatchObject({ code: 'forbidden', requiredPermission: 'secrets.manage' });
        const allowed = await call(
            harness,
            harness.signIn({ memberId: memberOf('owner') }),
            ENGINE_API_ROUTES.createSecret,
            {},
            { surprise: true },
        );
        expect(allowed.status).toBe(400);
    });

    it('answers an unadvertised capability route with 404 even when the input is invalid', async () => {
        const runsOnly = await createApiHarness({ capabilities: ['runs'] });
        try {
            const owner = runsOnly.signIn({ memberId: runsOnly.ownerId() });
            const result = await call(runsOnly, owner, ENGINE_API_ROUTES.createTrigger, {}, { surprise: true });
            expect(result.status).toBe(404);
            expect(result.body?.['code']).toBe('capability-not-supported');
            const viewer = runsOnly.signIn({ memberId: runsOnly.ownerId(), permissions: ['agents.read'] });
            expect((await call(runsOnly, viewer, ENGINE_API_ROUTES.deleteFile)).body?.['code']).toBe(
                'capability-not-supported',
            );
        } finally {
            await runsOnly.close();
        }
    });
});

describe('ownership', () => {
    async function agents() {
        const owner = harness.signIn({ memberId: memberOf('owner') });
        const listed = await call(harness, owner, ENGINE_API_ROUTES.listAgents, {}, undefined);
        return listed.body?.['items'] as {
            id: string;
            createdBy: string;
            currentRevisionId: string;
            deletedAt: string | null;
        }[];
    }

    it("refuses a member changing another member's agent, and lets them change their own", async () => {
        const memberId = memberOf('member');
        const cookie = harness.signIn({ memberId });
        const all = await agents();
        const own = all.find((agent) => agent.createdBy === memberId && agent.deletedAt === null);
        const other = all.find((agent) => agent.createdBy !== memberId && agent.deletedAt === null);
        if (own === undefined || other === undefined) throw new Error('seed lacks agents for the ownership test');
        const changes = [
            [ENGINE_API_ROUTES.updateAgent, { visibility: 'public' }],
            [ENGINE_API_ROUTES.updateAgentSource, { source: 'Changed', baseRevisionId: other.currentRevisionId }],
            [ENGINE_API_ROUTES.startAgent, undefined],
            [ENGINE_API_ROUTES.deleteAgent, undefined],
        ] as const;
        for (const [route, body] of changes) {
            const result = await call(harness, cookie, route, { agentId: other.id }, body);
            expect(result.status, route.id).toBe(403);
            expect(result.body, route.id).toMatchObject({ code: 'forbidden', requiredPermission: route.permission });
        }
        const ownChanges = [
            [ENGINE_API_ROUTES.updateAgent, { visibility: 'public' }],
            [ENGINE_API_ROUTES.updateAgentSource, { source: 'Changed', baseRevisionId: own.currentRevisionId }],
            [ENGINE_API_ROUTES.startAgent, undefined],
            [ENGINE_API_ROUTES.deleteAgent, undefined],
        ] as const;
        for (const [route, body] of ownChanges) {
            expect((await call(harness, cookie, route, { agentId: own.id }, body)).status, route.id).toBe(200);
        }
        // Reading and chatting are not changes: a member may do both on anyone's agent.
        expect((await call(harness, cookie, ENGINE_API_ROUTES.getAgent, { agentId: other.id })).status).toBe(200);
        expect((await call(harness, cookie, ENGINE_API_ROUTES.createChat, { agentId: other.id })).status).toBe(201);
    });

    it('lets a member read but not write in a chat another member started', async () => {
        const memberId = memberOf('member');
        const cookie = harness.signIn({ memberId });
        const owner = harness.signIn({ memberId: memberOf('owner') });
        const agent = (await agents()).find((candidate) => candidate.deletedAt === null);
        if (agent === undefined) throw new Error('no agent');
        const started = await call(harness, owner, ENGINE_API_ROUTES.createChat, { agentId: agent.id });
        const chatId = String(started.body?.['id']);
        expect((await call(harness, cookie, ENGINE_API_ROUTES.getChat, { chatId })).status).toBe(200);
        const sent = await call(harness, cookie, ENGINE_API_ROUTES.sendChatMessage, { chatId });
        expect(sent).toMatchObject({ status: 403, body: { code: 'forbidden', requiredPermission: 'chats.write' } });
        const own = await call(harness, cookie, ENGINE_API_ROUTES.createChat, { agentId: agent.id });
        const ownChatId = String(own.body?.['id']);
        expect((await call(harness, cookie, ENGINE_API_ROUTES.sendChatMessage, { chatId: ownChatId })).status).toBe(
            202,
        );
    });

    it("lets an admin change anyone's agent", async () => {
        const adminId = memberOf('admin');
        const cookie = harness.signIn({ memberId: adminId });
        const other = (await agents()).find((agent) => agent.createdBy !== adminId && agent.deletedAt === null);
        if (other === undefined) throw new Error('no agent');
        expect((await call(harness, cookie, ENGINE_API_ROUTES.updateAgent, { agentId: other.id })).status).toBe(200);
    });

    it('audits an ownership denial with the member who tried', async () => {
        const audit = await call(
            harness,
            harness.signIn({ memberId: memberOf('owner') }),
            ENGINE_API_ROUTES.listAuditEntries,
        );
        const denied = (
            audit.body?.['items'] as { outcome: string; actor: { memberId?: string }; action: string }[]
        ).filter((entry) => entry.outcome === 'denied' && entry.action === 'agent.update');
        expect(denied.some((entry) => entry.actor.memberId === memberOf('member'))).toBe(true);
    });
});

describe('revoked sessions', () => {
    function session(role: (typeof ROLES)[number]) {
        const signedIn = harness.sessions.signIn({
            memberId: memberOf(role),
            permissions: null,
            client: { ip: '198.51.100.23', userAgent: 'matrix' },
        });
        return { ...signedIn, cookie: `${SESSION_COOKIE_NAME}=${signedIn.token}` };
    }

    it('answers 401 on the next request after an admin revokes the session', async () => {
        const viewer = session('viewer');
        expect((await call(harness, viewer.cookie, ENGINE_API_ROUTES.getMe)).status).toBe(200);
        const owner = harness.signIn({ memberId: memberOf('owner') });
        expect(
            (await call(harness, owner, ENGINE_API_ROUTES.revokeSession, { sessionId: viewer.sessionId })).status,
        ).toBe(204);
        const after = await call(harness, viewer.cookie, ENGINE_API_ROUTES.getMe);
        expect(after).toMatchObject({ status: 401, body: { code: 'unauthenticated' } });
    });

    it('answers 401 on the next request after the member revokes it themselves', async () => {
        const member = session('member');
        const other = session('member');
        expect(
            (await call(harness, other.cookie, ENGINE_API_ROUTES.revokeMySession, { sessionId: member.sessionId }))
                .status,
        ).toBe(204);
        expect((await call(harness, member.cookie, ENGINE_API_ROUTES.listAgents)).status).toBe(401);
        expect((await call(harness, other.cookie, ENGINE_API_ROUTES.listAgents)).status).toBe(200);
    });
});
