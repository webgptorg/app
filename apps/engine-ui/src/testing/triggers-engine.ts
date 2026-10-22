import type { CapabilityRef, EngineApiClient, Permission } from '@ptbk/engine-api';
import { createInMemoryEngine } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineController, InMemorySeed, InMemorySeedTrigger } from '@ptbk/engine-api/in-memory';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { OWNER_ID } from './agents-engine';
import { HOSTILE } from './runs-engine';
import { TEST_NOW } from './test-engine-api';

export const TRIGGER_IDS = {
    weekday: 'trigger-weekday',
    inbox: 'trigger-inbox',
    paused: 'trigger-paused',
    failed: 'trigger-failed',
    ended: 'trigger-ended',
} as const;

export const INBOX_ADDRESS = 'trigger-inbox@engine.localhost';
/** Older interval schedules of Max, so the list has a second page. */
export const FILLER_TRIGGERS = 55;

const MINUTE = 60_000;
const at = (ms: number) => new Date(TEST_NOW.getTime() + ms).toISOString();

function schedule(
    id: string,
    fields: Partial<Extract<InMemorySeedTrigger, { kind: 'schedule' }>> & { readonly agentId: string },
    config: Partial<Extract<InMemorySeedTrigger, { kind: 'schedule' }>['config']> = {},
): InMemorySeedTrigger {
    return {
        id,
        name: id,
        kind: 'schedule',
        lifecycle: 'active',
        endedReason: null,
        lastFiredAt: null,
        nextFireAt: null,
        createdBy: OWNER_ID,
        createdAt: at(-60 * MINUTE),
        updatedAt: at(-60 * MINUTE),
        ...fields,
        config: {
            recurrence: { kind: 'interval', everySeconds: 3600 },
            startsAt: at(-60 * MINUTE),
            endsAt: null,
            maxRunCount: null,
            runCount: 0,
            message: 'Check the inbox.',
            ...config,
        },
    };
}

/** Triggers in every lifecycle and kind across three agents, a hostile message and enough for two pages. */
export function triggersSeed(): InMemorySeed {
    const filler = Array.from({ length: FILLER_TRIGGERS }, (_, index) => ({
        trigger: schedule(`trigger-old-${String(index + 1).padStart(3, '0')}`, {
            agentId: 'agent-max',
            name: `Nightly import ${String(index + 1)}`,
            createdAt: at(-(3 + index) * 60 * MINUTE),
            nextFireAt: at((index + 1) * 60 * MINUTE),
        }),
    }));
    return {
        engine: { name: 'Test engine', hostname: 'engine.localhost', dashboardUrl: null, mode: 'local' },
        agents: [
            { id: 'agent-ada', source: 'Ada\nPERSONA Research' },
            { id: 'agent-iris', source: 'Iris\nPERSONA Reports' },
            { id: 'agent-max', source: 'Max\nPERSONA Imports' },
        ],
        triggers: [
            ...filler,
            {
                trigger: schedule(
                    TRIGGER_IDS.weekday,
                    {
                        agentId: 'agent-iris',
                        name: 'Morning report',
                        createdAt: at(-1 * MINUTE),
                        lastFiredAt: at(-28 * 60 * MINUTE),
                        nextFireAt: '2026-10-02T06:00:00.000Z',
                    },
                    {
                        recurrence: { kind: 'cron', expression: '0 8 * * 1-5', timeZone: 'Europe/Prague' },
                        runCount: 2,
                        message: `Write the morning report. ${HOSTILE}`,
                    },
                ),
                fires: [
                    {
                        id: 'fire-1',
                        at: at(-52 * 60 * MINUTE),
                        outcome: 'failed',
                        runId: null,
                        error: { code: 'agent-unavailable', summary: `Nothing ran: ${HOSTILE}` },
                    },
                    { id: 'fire-2', at: at(-28 * 60 * MINUTE), outcome: 'started', runId: 'run-morning', error: null },
                ],
            },
            {
                trigger: {
                    id: TRIGGER_IDS.inbox,
                    agentId: 'agent-ada',
                    name: 'Support inbox',
                    kind: 'email',
                    lifecycle: 'active',
                    endedReason: null,
                    lastFiredAt: null,
                    nextFireAt: null,
                    createdBy: OWNER_ID,
                    createdAt: at(-2 * MINUTE),
                    updatedAt: at(-2 * MINUTE),
                    config: { address: INBOX_ADDRESS },
                },
            },
            {
                trigger: schedule(
                    TRIGGER_IDS.paused,
                    {
                        agentId: 'agent-max',
                        name: 'Every quarter hour',
                        lifecycle: 'paused',
                        createdAt: at(-3 * MINUTE),
                    },
                    { recurrence: { kind: 'interval', everySeconds: 900 } },
                ),
            },
            {
                trigger: schedule(TRIGGER_IDS.failed, {
                    agentId: 'agent-iris',
                    name: 'Calendar sync',
                    lifecycle: 'failed',
                    createdAt: at(-4 * MINUTE),
                }),
            },
            {
                trigger: schedule(
                    TRIGGER_IDS.ended,
                    {
                        agentId: 'agent-ada',
                        name: 'Launch reminder',
                        lifecycle: 'ended',
                        endedReason: 'completed',
                        createdAt: at(-5 * MINUTE),
                        lastFiredAt: at(-30 * MINUTE),
                    },
                    { recurrence: { kind: 'once', at: at(-30 * MINUTE) }, runCount: 1 },
                ),
            },
        ],
    };
}

type TriggerMethods = EngineApiClient['triggers'];

export interface TriggersEngine {
    /** Pass as `engineApi`; trigger methods are spies, so tests count, inspect and override calls. */
    readonly client: EngineApiClient;
    readonly controller: InMemoryEngineController;
    readonly spies: { readonly [Key in keyof TriggerMethods]: MockInstance<TriggerMethods[Key]> };
}

export interface TriggersEngineOptions {
    readonly seed?: InMemorySeed;
    readonly permissions?: readonly Permission[];
    readonly capabilities?: readonly CapabilityRef[];
}

export function createTriggersEngine(options: TriggersEngineOptions = {}): TriggersEngine {
    const engine = createInMemoryEngine({
        clock: { now: () => TEST_NOW },
        seed: options.seed ?? triggersSeed(),
        ...(options.permissions === undefined
            ? {}
            : { member: { id: OWNER_ID, permissions: options.permissions, role: 'member' } }),
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    });
    const triggers = { ...engine.client.triggers };
    const spies = {
        list: vi.spyOn(triggers, 'list'),
        stats: vi.spyOn(triggers, 'stats'),
        create: vi.spyOn(triggers, 'create'),
        get: vi.spyOn(triggers, 'get'),
        update: vi.spyOn(triggers, 'update'),
        delete: vi.spyOn(triggers, 'delete'),
        pause: vi.spyOn(triggers, 'pause'),
        resume: vi.spyOn(triggers, 'resume'),
        listFires: vi.spyOn(triggers, 'listFires'),
    };
    return { client: { ...engine.client, triggers }, controller: engine.controller, spies };
}
