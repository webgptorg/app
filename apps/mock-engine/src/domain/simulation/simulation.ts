import type { Run, TriggerFire } from '@ptbk/engine-api';
import type { InMemoryEngineController } from '@ptbk/engine-api/in-memory';

import type { FaultPlan } from '../faults/fault-plan';
import { createSeededSequence, hashSeed } from '../state/seed-random';
import type { RunScript } from './run-simulator';
import { createRunSimulator } from './run-simulator';
import { createScheduleSimulator } from './schedule-simulator';
import type { SimulationClock, SimulationMode } from './simulation-clock';

const MINUTE = 60_000;
/** Sources of the runs the simulation starts on its own; chat, email and schedule runs have their own causes. */
const SPONTANEOUS_SOURCES = ['api', 'api', 'member', 'member', 'goal', 'webhook'] as const;

export interface SimulationOptions {
    readonly controller: InMemoryEngineController;
    readonly clock: SimulationClock;
    readonly seed: number;
    readonly scenario: string;
    readonly faults: () => FaultPlan;
    readonly onError: (error: unknown) => void;
}

export interface SimulationStatus {
    readonly mode: SimulationMode;
    readonly speed: number;
    /** The engine's time. */
    readonly now: string;
}

export interface ScriptedRunInput extends RunScript {
    readonly agentId: string;
    readonly source: 'api' | 'member' | 'goal' | 'webhook';
}

export type InboundEmailOutcome =
    | { readonly kind: 'fired'; readonly fire: TriggerFire }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'not-email' };

/** The live engine on top of one core: runs progress, schedules fire, new runs come in. */
export interface Simulation {
    status(): SimulationStatus;
    /** Throws for an unknown or deleted agent. */
    scriptRun(input: ScriptedRunInput): Run;
    /** An email arrived for an email trigger; its subject becomes the run's preview. */
    inboundEmail(triggerId: string, subject: string): InboundEmailOutcome;
    /** The fault plan changed: runs held back by `stuckQueue` may go on. */
    faultsChanged(): void;
    stop(): void;
}

/**
 * Everything the engine does on its own, through the core's levers only, on the simulation clock and a sequence
 * seeded from (seed, scenario): the same seed, scenario, epoch and `advance` calls give the same engine.
 */
export function createSimulation(options: SimulationOptions): Simulation {
    const { controller, clock } = options;
    const sequence = createSeededSequence(hashSeed(options.seed, options.scenario, 'simulation'));
    const runs = createRunSimulator({
        controller,
        clock,
        sequence,
        faults: options.faults,
        onError: options.onError,
    });
    const schedules = createScheduleSimulator({ controller, clock, onError: options.onError });
    let stopped = false;
    let cancelSpontaneous: (() => void) | null = null;

    const unsubscribe = controller.onEvent((event) => {
        if (event.type === 'run.changed' && event.status === 'queued') runs.consider(event.runId);
        if (event.type === 'trigger.changed') schedules.refresh();
    });

    /** API clients, members and goals start runs now and then. */
    function spontaneous(): void {
        cancelSpontaneous = clock.setTimeout(
            () => {
                if (stopped) return;
                try {
                    const agents = controller.findAgents();
                    if (agents.length > 0) {
                        const source = sequence.pick(SPONTANEOUS_SOURCES);
                        const members = controller
                            .inspect()
                            .members.filter(({ role, status }) => role !== 'viewer' && status === 'active');
                        const createdBy =
                            (source === 'api' || source === 'member') && members.length > 0
                                ? sequence.pick(members).id
                                : null;
                        controller.startRun({ agentId: sequence.pick(agents).id, source, createdBy });
                    }
                } catch (error) {
                    options.onError(error);
                }
                spontaneous();
            },
            sequence.int(MINUTE, 6 * MINUTE),
        );
    }

    for (const run of controller.findRuns({ status: ['queued', 'running'] })) runs.consider(run.id);
    schedules.refresh();
    spontaneous();

    return {
        status: () => ({ mode: clock.mode(), speed: clock.speed(), now: new Date(clock.nowMs()).toISOString() }),
        scriptRun(input) {
            const run = controller.startRun({ agentId: input.agentId, source: input.source });
            runs.script(run.id, { outcome: input.outcome, steps: input.steps });
            return run;
        },
        inboundEmail(triggerId, subject) {
            const trigger = controller.getTrigger(triggerId);
            if (trigger === undefined) return { kind: 'not-found' };
            if (trigger.kind !== 'email') return { kind: 'not-email' };
            return { kind: 'fired', fire: controller.fireTrigger(triggerId, { subject }) };
        },
        faultsChanged() {
            runs.release();
        },
        stop() {
            stopped = true;
            unsubscribe();
            cancelSpontaneous?.();
            runs.stop();
            schedules.stop();
        },
    };
}
