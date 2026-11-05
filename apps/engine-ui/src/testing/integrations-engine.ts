import type { CapabilityRef, EngineApiClient, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineController, InMemorySeed } from '@ptbk/engine-api/in-memory';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { OWNER_ID } from './agents-engine';
import { TEST_NOW } from './test-engine-api';

/** Text from a third party (a tool description, a status detail) that tries to become markup or a navigation. */
export const HOSTILE_TEXT = '<img src=x onerror=alert(1)> <script>alert(1)</script> javascript:alert(1)';

export const INTEGRATION_IDS = {
    docs: 'int-docs',
    billing: 'int-billing',
    calendar: 'int-calendar',
    off: 'int-off',
} as const;

/** Older MCP servers of Max, so the global list has a second page. */
export const FILLER_INTEGRATIONS = 52;

const ago = (minutes: number) => new Date(TEST_NOW.getTime() - minutes * 60_000).toISOString();

type SeedIntegration = NonNullable<InMemorySeed['integrations']>[number];

const base = {
    statusDetail: null,
    scopes: [],
    secretRefs: [],
    tools: [],
    lastActivityAt: null,
    createdBy: OWNER_ID,
    updatedAt: ago(1),
};

function mcp(id: string, fields: Partial<SeedIntegration> & { readonly createdAt: string }): SeedIntegration {
    return {
        ...base,
        id,
        agentId: null,
        name: id,
        status: 'connected',
        kind: 'mcp-server',
        config: { url: 'https://mcp.example.com/sse' },
        ...fields,
    } as SeedIntegration;
}

/** One integration of each kind and status across agents and engine-wide, the hostile samples and two pages. */
export function integrationsSeed(): InMemorySeed {
    const filler = Array.from({ length: FILLER_INTEGRATIONS }, (_, index) =>
        mcp(`int-old-${String(index + 1).padStart(3, '0')}`, {
            agentId: 'agent-max',
            name: `Import source ${String(index + 1)}`,
            createdAt: ago(600 + index),
        }),
    );
    return {
        engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
        agents: [
            { id: 'agent-ada', source: 'Ada\nPERSONA Research' },
            { id: 'agent-grace', source: 'Grace\nPERSONA Review' },
            { id: 'agent-max', source: 'Max\nPERSONA Imports' },
        ],
        integrationSecrets: [
            { id: 'secret-docs', name: 'DOCS_TOKEN', scope: { kind: 'engine' }, status: 'active' },
            {
                id: 'secret-old',
                name: 'OLD_CALENDAR_TOKEN',
                scope: { kind: 'agent', agentId: 'agent-ada' },
                status: 'revoked',
            },
        ],
        integrations: [
            mcp(INTEGRATION_IDS.docs, {
                name: 'Docs search',
                createdAt: ago(10),
                scopes: ['docs:read', 'docs:search'],
                secretRefs: [{ name: 'DOCS_TOKEN', secretId: 'secret-docs', state: 'resolved' }],
                tools: [
                    { name: 'search', description: 'Searches the documentation.' },
                    { name: 'fetch_page', description: HOSTILE_TEXT },
                ],
                lastActivityAt: ago(5),
            }),
            {
                ...base,
                id: INTEGRATION_IDS.billing,
                agentId: 'agent-ada',
                name: 'Billing repository',
                kind: 'repository',
                status: 'needs-attention',
                statusDetail: 'Secrets not available: GITHUB_TOKEN.',
                scopes: ['contents:read'],
                secretRefs: [{ name: 'GITHUB_TOKEN', secretId: null, state: 'missing' }],
                config: { provider: 'github', repository: 'acme/billing' },
                createdAt: ago(20),
            },
            {
                ...base,
                id: INTEGRATION_IDS.calendar,
                agentId: 'agent-ada',
                name: 'Ada’s calendar',
                kind: 'calendar',
                status: 'error',
                statusDetail: `The provider refused the token: ${HOSTILE_TEXT}`,
                scopes: ['calendar.events.read'],
                secretRefs: [{ name: 'OLD_CALENDAR_TOKEN', secretId: 'secret-old', state: 'revoked' }],
                config: { provider: 'google', account: 'ada@example.com' },
                createdAt: ago(30),
            },
            mcp(INTEGRATION_IDS.off, {
                agentId: 'agent-grace',
                name: 'Review bot',
                status: 'disconnected',
                createdAt: ago(40),
            }),
            ...filler,
        ],
        activity: [
            {
                kind: 'integration.connected',
                v: 1,
                id: 'act-1',
                at: ago(9),
                agentId: null,
                actor: { kind: 'member', memberId: OWNER_ID },
                integrationId: INTEGRATION_IDS.docs,
                name: 'Docs search',
            },
            {
                kind: 'integration.used',
                v: 1,
                id: 'act-2',
                at: ago(5),
                agentId: 'agent-ada',
                actor: { kind: 'system' },
                integrationId: INTEGRATION_IDS.docs,
                name: 'Docs search',
                toolName: 'search',
                runId: null,
            },
        ],
    };
}

type IntegrationMethods = EngineApiClient['integrations'];

export interface IntegrationsEngine {
    /** Pass as `engineApi`; integration and activity methods are spies, so tests count, inspect and override calls. */
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
    readonly spies: { readonly [Key in keyof IntegrationMethods]: MockInstance<IntegrationMethods[Key]> } & {
        readonly activity: MockInstance<EngineApiClient['activity']['list']>;
    };
}

export interface IntegrationsEngineOptions {
    readonly seed?: InMemorySeed;
    readonly permissions?: readonly Permission[];
    readonly capabilities?: readonly CapabilityRef[];
}

export function createIntegrationsEngine(options: IntegrationsEngineOptions = {}): IntegrationsEngine {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: options.seed ?? integrationsSeed(),
        ...(options.permissions === undefined
            ? {}
            : { member: { id: OWNER_ID, permissions: options.permissions, role: 'member' } }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    });
    const integrations = { ...engine.client.integrations };
    const activity = { ...engine.client.activity };
    const spies = {
        list: vi.spyOn(integrations, 'list'),
        stats: vi.spyOn(integrations, 'stats'),
        create: vi.spyOn(integrations, 'create'),
        connectCalendar: vi.spyOn(integrations, 'connectCalendar'),
        get: vi.spyOn(integrations, 'get'),
        update: vi.spyOn(integrations, 'update'),
        delete: vi.spyOn(integrations, 'delete'),
        enable: vi.spyOn(integrations, 'enable'),
        disable: vi.spyOn(integrations, 'disable'),
        check: vi.spyOn(integrations, 'check'),
        activity: vi.spyOn(activity, 'list'),
    };
    return { client: { ...engine.client, integrations, activity }, controller: engine.controller, spies };
}
