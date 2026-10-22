import type { CapabilityRef, EngineApiClient, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineController, InMemorySeed, InMemorySeedActivity } from '@ptbk/engine-api/in-memory';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { OWNER_ID } from './agents-engine';
import { runsSeed } from './runs-engine';
import { TEST_NOW } from './test-engine-api';

const ago = (minutes: number) => new Date(TEST_NOW.getTime() - minutes * 60_000).toISOString();

/** `count` activity items, newest first by `at`: runs of Ada, then a member joining. */
export function seededActivity(count: number): InMemorySeedActivity[] {
    return Array.from({ length: count }, (_, index): InMemorySeedActivity => {
        const at = ago(count - index);
        const id = `activity-${String(index + 1).padStart(3, '0')}`;
        return index % 5 === 4
            ? {
                  kind: 'member.joined',
                  v: 1,
                  id,
                  at,
                  agentId: null,
                  actor: { kind: 'system' },
                  memberId: `member-${String(index)}`,
                  displayName: `Member ${String(index)}`,
              }
            : {
                  kind: 'run.completed',
                  v: 1,
                  id,
                  at,
                  agentId: 'agent-ada',
                  actor: { kind: 'system' },
                  runId: 'run-completed',
                  source: 'web',
                  usage: null,
              };
    });
}

export interface HomeEngineOptions {
    readonly permissions?: readonly Permission[];
    readonly capabilities?: readonly CapabilityRef[];
    /** Seeded activity items (oldest first); default 3. */
    readonly activity?: readonly InMemorySeedActivity[];
    readonly seed?: Partial<InMemorySeed>;
}

type Spied<Group extends keyof EngineApiClient, Method extends keyof EngineApiClient[Group]> = MockInstance<
    Extract<EngineApiClient[Group][Method], (...args: never[]) => unknown>
>;

export interface HomeEngine {
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
    readonly spies: {
        readonly activity: Spied<'activity', 'list'>;
        readonly agents: Spied<'agents', 'list'>;
        readonly runs: Spied<'runs', 'list'>;
        readonly runStats: Spied<'runs', 'stats'>;
        readonly runGet: Spied<'runs', 'get'>;
        readonly runCancel: Spied<'runs', 'cancel'>;
        readonly chats: Spied<'chats', 'listAll'>;
        readonly security: Spied<'security', 'get'>;
    };
}

/** The runs seed (four agents, runs in every status) with activity, acting as the owner unless permissions say else. */
export function createHomeEngine(options: HomeEngineOptions = {}): HomeEngine {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: { ...runsSeed(), activity: options.activity ?? seededActivity(3), ...options.seed },
        ...(options.permissions === undefined
            ? {}
            : { member: { id: OWNER_ID, permissions: options.permissions, role: 'member' } }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    });
    const activity = { ...engine.client.activity };
    const agents = { ...engine.client.agents };
    const runs = { ...engine.client.runs };
    const chats = { ...engine.client.chats };
    const security = { ...engine.client.security };
    const spies = {
        activity: vi.spyOn(activity, 'list'),
        agents: vi.spyOn(agents, 'list'),
        runs: vi.spyOn(runs, 'list'),
        runStats: vi.spyOn(runs, 'stats'),
        runGet: vi.spyOn(runs, 'get'),
        runCancel: vi.spyOn(runs, 'cancel'),
        chats: vi.spyOn(chats, 'listAll'),
        security: vi.spyOn(security, 'get'),
    };
    return {
        client: { ...engine.client, activity, agents, runs, chats, security },
        controller: engine.controller,
        spies,
    };
}
