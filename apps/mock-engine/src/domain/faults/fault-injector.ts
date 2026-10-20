import type { FaultPlan } from './fault-plan';
import { matchesRoutes } from './fault-plan';

/** Uniform in [0, 1); seeded in tests so fault rates are reproducible. */
export interface UnitRandom {
    next(): number;
}

export interface FaultDecision {
    readonly latencyMs: number;
    readonly error: FaultPlan['errorStatus'] | null;
    /** Cut an SSE response after this many events; `null` leaves it alone. */
    readonly dropStreamAfterEvents: number | null;
}

export interface FaultInjector {
    decide(path: string): FaultDecision;
}

const MAX_EVENTS_BEFORE_DROP = 20;
const NONE: FaultDecision = Object.freeze({ latencyMs: 0, error: null, dropStreamAfterEvents: null });

/** Reads the plan on every request, so a runtime change applies from the next request on. */
export function createFaultInjector(deps: {
    readonly plan: () => FaultPlan;
    readonly random: UnitRandom;
}): FaultInjector {
    return {
        decide(path) {
            const plan = deps.plan();
            if (!matchesRoutes(plan, path)) return NONE;
            const { min, max } = plan.latencyMs;
            // Every draw is made whatever the rates, so one setting never shifts another's sequence.
            const latencyMs = min + Math.floor(deps.random.next() * (max - min + 1));
            const error = deps.random.next() < plan.errorRate ? plan.errorStatus : null;
            const drop = deps.random.next() < plan.dropStreamRate;
            const after = 1 + Math.floor(deps.random.next() * MAX_EVENTS_BEFORE_DROP);
            return { latencyMs, error, dropStreamAfterEvents: drop ? after : null };
        },
    };
}
