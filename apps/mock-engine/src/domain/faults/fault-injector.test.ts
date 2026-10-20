import { describe, expect, it } from 'vitest';

import { createFaultInjector } from './fault-injector';
import type { UnitRandom } from './fault-injector';
import { FaultPlan, NO_FAULTS } from './fault-plan';

/** Mulberry32, seeded: reproducible draws for rate checks. */
function seeded(seed: number): UnitRandom {
    let state = seed >>> 0;
    return {
        next() {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
        },
    };
}

const decisions = (plan: FaultPlan, count = 1000, path = '/api/v1/agents') => {
    const injector = createFaultInjector({ plan: () => plan, random: seeded(1234) });
    return Array.from({ length: count }, () => injector.decide(path));
};

describe('createFaultInjector', () => {
    it('injects nothing with the default plan', () => {
        for (const decision of decisions(NO_FAULTS, 100)) {
            expect(decision).toEqual({ latencyMs: 0, error: null, dropStreamAfterEvents: null });
        }
    });

    it('keeps latency within bounds and uses the whole range', () => {
        const all = decisions(FaultPlan.parse({ latencyMs: { min: 20, max: 80 } })).map((d) => d.latencyMs);
        expect(Math.min(...all)).toBe(20);
        expect(Math.max(...all)).toBe(80);
        expect(all.every((ms) => Number.isInteger(ms))).toBe(true);
    });

    it('fails requests at the configured rate and status', () => {
        const all = decisions(FaultPlan.parse({ errorRate: 0.3, errorStatus: 502 }));
        const failed = all.filter((d) => d.error !== null);
        expect(failed.length / all.length).toBeGreaterThan(0.25);
        expect(failed.length / all.length).toBeLessThan(0.35);
        expect(new Set(failed.map((d) => d.error))).toEqual(new Set([502]));
    });

    it('cuts streams at the configured rate, after 1 to 20 events', () => {
        const all = decisions(FaultPlan.parse({ dropStreamRate: 0.2 }));
        const dropped = all.flatMap((d) => (d.dropStreamAfterEvents === null ? [] : [d.dropStreamAfterEvents]));
        expect(dropped.length / all.length).toBeGreaterThan(0.15);
        expect(dropped.length / all.length).toBeLessThan(0.25);
        expect(Math.min(...dropped)).toBe(1);
        expect(Math.max(...dropped)).toBe(20);
    });

    it('is reproducible for the same seed', () => {
        const plan = FaultPlan.parse({ latencyMs: { min: 0, max: 100 }, errorRate: 0.5, dropStreamRate: 0.5 });
        expect(decisions(plan, 50)).toEqual(decisions(plan, 50));
    });

    it('leaves paths outside the route filter alone', () => {
        const plan = FaultPlan.parse({ errorRate: 1, routes: ['/api/v1/chats/**'] });
        expect(decisions(plan, 10, '/api/v1/agents').every((d) => d.error === null)).toBe(true);
        expect(decisions(plan, 10, '/api/v1/chats/c1/messages').every((d) => d.error === 503)).toBe(true);
    });

    it('applies a runtime plan change on the next decision', () => {
        let plan = NO_FAULTS;
        const injector = createFaultInjector({ plan: () => plan, random: seeded(9) });
        expect(injector.decide('/x').error).toBeNull();
        plan = FaultPlan.parse({ errorRate: 1, errorStatus: 500 });
        expect(injector.decide('/x').error).toBe(500);
        plan = NO_FAULTS;
        expect(injector.decide('/x').error).toBeNull();
    });
});
