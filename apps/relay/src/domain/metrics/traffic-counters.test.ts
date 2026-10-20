import type { EngineId } from '@ptbk/protocol';
import { EngineId as EngineIdSchema } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createTestDeps } from '../../testing/test-deps';
import { createTrafficCounters } from './traffic-counters';

const engineA: EngineId = EngineIdSchema.parse('a'.repeat(26));
const engineB: EngineId = EngineIdSchema.parse('b'.repeat(26));
const DAY_MS = 86_400_000;

describe('createTrafficCounters', () => {
    it('adds up bytes per engine, direction and UTC day', () => {
        const { clock } = createTestDeps(Date.UTC(2026, 9, 20, 23, 59));
        const counters = createTrafficCounters({ clock, retainDays: 2 });
        counters.record(engineA, 'in', 100);
        counters.record(engineA, 'out', 40);
        counters.record(engineA, 'in', 1);
        counters.record(engineB, 'out', 7);
        clock.advance(60_000);
        counters.record(engineA, 'out', 5);
        expect(counters.snapshot()).toEqual([
            { day: '2026-10-20', engineId: engineA, bytesIn: 101, bytesOut: 40 },
            { day: '2026-10-20', engineId: engineB, bytesIn: 0, bytesOut: 7 },
            { day: '2026-10-21', engineId: engineA, bytesIn: 0, bytesOut: 5 },
        ]);
    });

    it('keeps only the retained days', () => {
        const { clock } = createTestDeps(Date.UTC(2026, 9, 20, 12));
        const counters = createTrafficCounters({ clock, retainDays: 2 });
        counters.record(engineA, 'in', 1);
        clock.advance(DAY_MS);
        counters.record(engineA, 'in', 2);
        expect(counters.snapshot().map((entry) => entry.day)).toEqual(['2026-10-20', '2026-10-21']);
        clock.advance(DAY_MS);
        expect(counters.snapshot()).toEqual([{ day: '2026-10-21', engineId: engineA, bytesIn: 2, bytesOut: 0 }]);
        clock.advance(DAY_MS);
        expect(counters.snapshot()).toEqual([]);
    });

    it('refuses to retain less than a day', () => {
        const { clock } = createTestDeps();
        expect(() => createTrafficCounters({ clock, retainDays: 0 })).toThrow(RangeError);
        expect(() => createTrafficCounters({ clock, retainDays: 1.5 })).toThrow(RangeError);
    });
});
