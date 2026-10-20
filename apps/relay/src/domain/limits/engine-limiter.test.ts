import type { EngineId } from '@ptbk/protocol';
import { EngineId as EngineIdSchema } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createTestDeps } from '../../testing/test-deps';
import type { EngineLimits, StreamAdmission } from './engine-limiter';
import { createEngineLimiter } from './engine-limiter';

const engineA: EngineId = EngineIdSchema.parse('a'.repeat(26));
const engineB: EngineId = EngineIdSchema.parse('b'.repeat(26));
const limits: EngineLimits = { maxStreams: 2, newStreamsPerS: 10, bandwidthBytesPerS: 1000 };

function setup(overrides: Partial<EngineLimits> = {}) {
    const { clock } = createTestDeps();
    return { clock, limiter: createEngineLimiter({ ...limits, ...overrides }, clock) };
}

const kinds = (admissions: readonly StreamAdmission[]): readonly string[] =>
    admissions.map((admission) => (admission.kind === 'admitted' ? 'admitted' : admission.reason));

function release(admission: StreamAdmission | undefined): void {
    if (admission?.kind !== 'admitted') throw new Error('expected an admission');
    admission.release();
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A distinct engine ID per index, never `engineA`'s all-`a` one. */
function engineId(index: number): EngineId {
    let id = '';
    for (let rest = index + 1, digit = 0; digit < 26; digit++, rest = Math.floor(rest / 32))
        id = BASE32.charAt(rest % 32) + id;
    return EngineIdSchema.parse(id);
}

describe('createEngineLimiter', () => {
    it('caps open streams per engine and frees a slot when a stream ends, once', () => {
        const { limiter } = setup();
        const admissions = [1, 2, 3].map(() => limiter.admitStream(engineA));
        expect(kinds(admissions)).toEqual(['admitted', 'admitted', 'engine-streams']);
        expect(limiter.admitStream(engineB).kind).toBe('admitted');
        release(admissions[0]);
        release(admissions[0]);
        expect(kinds([limiter.admitStream(engineA), limiter.admitStream(engineA)])).toEqual([
            'admitted',
            'engine-streams',
        ]);
    });

    it('limits new streams per engine per second', () => {
        const { clock, limiter } = setup({ maxStreams: 100, newStreamsPerS: 2 });
        expect(kinds([1, 2, 3].map(() => limiter.admitStream(engineA)))).toEqual([
            'admitted',
            'admitted',
            'engine-rate',
        ]);
        expect(limiter.admitStream(engineB).kind).toBe('admitted');
        clock.advance(500);
        expect(limiter.admitStream(engineA).kind).toBe('admitted');
    });

    it('charges bandwidth per engine, both directions from one budget', () => {
        const { clock, limiter } = setup();
        expect(limiter.throttle(engineA, 600)).toBe(0);
        expect(limiter.throttle(engineA, 600)).toBe(200);
        expect(limiter.throttle(engineB, 1000)).toBe(0);
        clock.advance(200);
        expect(limiter.throttle(engineA, 1)).toBe(1);
    });

    it('forgets idle engines once their budgets are full again', () => {
        const { clock, limiter } = setup({ newStreamsPerS: 1 });
        const busy = limiter.admitStream(engineA);
        for (let index = 0; index < 1023; index++) release(limiter.admitStream(engineId(index)));
        expect(limiter.trackedEngines()).toBe(1024);
        // The engines' stream buckets are still refilling: a sweep removes nothing yet.
        limiter.throttle(engineB, 1);
        expect(limiter.trackedEngines()).toBe(1025);
        clock.advance(1000);
        for (let index = 1023; index < 2046; index++) limiter.throttle(engineId(index), 2000);
        expect(limiter.trackedEngines()).toBe(2048);
        limiter.throttle(EngineIdSchema.parse('c'.repeat(26)), 1);
        // Swept at 2048: the refilled idle engines went; the busy one and those still in debt stay.
        expect(limiter.trackedEngines()).toBe(1 + 1023 + 1);
        expect(busy.kind).toBe('admitted');
        expect(limiter.admitStream(engineA).kind).toBe('admitted');
    });
});
