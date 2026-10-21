import type { AgentRunState, AgentVisibility, CapabilityRef, EngineApiClient, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineController, InMemorySeedAgent } from '@ptbk/engine-api/in-memory';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { TEST_NOW } from './test-engine-api';

export const OWNER_ID = 'member-owner';
export const SECOND_MEMBER_ID = 'member-jana';
export const SECOND_MEMBER_NAME = 'Jana Nováková';

const STATES: readonly AgentRunState[] = ['idle', 'running', 'stopped', 'error'];
const VISIBILITIES: readonly AgentVisibility[] = ['private', 'public', 'unlisted'];

/** Agent `index` (1-based): named `Agent 001`…, updated `index` minutes before `TEST_NOW`, so newest first is 001. */
export function seededAgent(index: number): Required<Pick<InMemorySeedAgent, 'id' | 'source'>> & InMemorySeedAgent {
    const number = String(index).padStart(3, '0');
    const topic = index % 2 === 0 ? 'support email' : 'research notes';
    return {
        id: `agent-${number}`,
        source: `Agent ${number}\nPERSONA Handles ${topic}`,
        createdAt: new Date(TEST_NOW.getTime() - index * 60_000).toISOString(),
        // Every third agent belongs to someone else, and the owner still sees and controls it.
        createdBy: index % 3 === 0 ? SECOND_MEMBER_ID : OWNER_ID,
        runState: STATES[index % STATES.length] ?? 'idle',
        visibility: VISIBILITIES[index % VISIBILITIES.length] ?? 'private',
    };
}

export interface AgentsEngineOptions {
    readonly agentCount?: number;
    readonly agents?: readonly InMemorySeedAgent[];
    readonly permissions?: readonly Permission[];
    readonly capabilities?: readonly CapabilityRef[];
    readonly stepUp?: 'satisfied' | 'required';
}

export interface AgentsEngine {
    /** Pass as `engineApi`; agent methods are spies, so tests can count and override calls. */
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
    readonly agents: { -readonly [Key in keyof EngineApiClient['agents']]: EngineApiClient['agents'][Key] };
    readonly spies: {
        readonly [Key in 'list' | 'get' | 'getStatus' | 'update' | 'delete' | 'start' | 'stop']: MockInstance<
            EngineApiClient['agents'][Key]
        >;
    };
}

/** The in-memory engine seeded with `agentCount` agents (default 120) from two members. */
export function createAgentsEngine(options: AgentsEngineOptions = {}): AgentsEngine {
    const count = options.agentCount ?? 120;
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: {
            engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
            members: [
                {
                    id: SECOND_MEMBER_ID,
                    displayName: SECOND_MEMBER_NAME,
                    role: 'admin',
                    status: 'active',
                    createdAt: '2026-09-01T00:00:00.000Z',
                    lastSeenAt: null,
                },
            ],
            agents: options.agents ?? Array.from({ length: count }, (_, index) => seededAgent(index + 1)),
        },
        ...(options.permissions === undefined
            ? {}
            : { member: { id: OWNER_ID, permissions: options.permissions, role: 'member' } }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        ...(options.stepUp === undefined ? {} : { stepUp: options.stepUp }),
    });
    const agents = { ...engine.client.agents };
    const spies = {
        list: vi.spyOn(agents, 'list'),
        get: vi.spyOn(agents, 'get'),
        getStatus: vi.spyOn(agents, 'getStatus'),
        update: vi.spyOn(agents, 'update'),
        delete: vi.spyOn(agents, 'delete'),
        start: vi.spyOn(agents, 'start'),
        stop: vi.spyOn(agents, 'stop'),
    };
    return { client: { ...engine.client, agents }, controller: engine.controller, agents, spies };
}
