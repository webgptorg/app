import { describe, expect, it } from 'vitest';

import { EngineEventReader } from '../events';
import { ACTIVITY_KINDS, ActivityPageReader, parseActivity } from './activity';
import { activitySample } from './fixtures/samples';

/** mulberry32: a tiny seeded PRNG, so every run explores the same cases and a failure reproduces. */
function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const FIELD_NAMES = [
    'kind',
    'v',
    'id',
    'at',
    'agentId',
    'agentName',
    'actor',
    'memberId',
    'triggerId',
    'runId',
    'source',
    'usage',
    'error',
    'name',
    'type',
    'activity',
    '__proto__',
    'constructor',
];
const STRINGS = [
    '',
    'run.',
    'x.y',
    'activity-1',
    '2026-10-20T08:00:00Z',
    'member',
    'system',
    'trigger',
    '\u0000',
    '💥',
    ...ACTIVITY_KINDS,
];
const NUMBERS = [0, 1, 2, -1, 1.5, Number.MAX_SAFE_INTEGER, 1e308];

function generator(random: () => number) {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

    const json = (depth: number): unknown => {
        const roll = random();
        if (depth <= 0 || roll < 0.35) {
            const scalar = random();
            if (scalar < 0.2) return null;
            if (scalar < 0.35) return random() < 0.5;
            if (scalar < 0.6) return pick(NUMBERS);
            if (scalar < 0.85) return pick(STRINGS);
            return Math.floor(random() * 1e6).toString(36);
        }
        if (roll < 0.55) return Array.from({ length: Math.floor(random() * 4) }, () => json(depth - 1));
        const object: Record<string, unknown> = {};
        for (let index = Math.floor(random() * 6); index > 0; index--) {
            const key = random() < 0.7 ? pick(FIELD_NAMES) : Math.floor(random() * 1e4).toString(36);
            Object.defineProperty(object, key, {
                value: json(depth - 1),
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
        return object;
    };

    /** A valid item with one field replaced, removed or added, to probe the edges of each schema. */
    const mutant = (): unknown => {
        const sample = activitySample(pick(ACTIVITY_KINDS));
        const keys = Object.keys(sample);
        const key = random() < 0.8 ? pick(keys) : pick(FIELD_NAMES);
        const action = random();
        if (action < 0.3) Reflect.deleteProperty(sample, key);
        else sample[key] = json(2);
        return sample;
    };

    return { json, mutant };
}

const CASES = 4000;

describe('activity reading on arbitrary input', () => {
    const { json, mutant } = generator(prng(0xc07));
    const inputs = Array.from({ length: CASES }, (_, index) => (index % 2 === 0 ? json(4) : mutant()));

    it('parseActivity never throws and always returns one of its four results', () => {
        const seen = new Set<string>();
        for (const input of inputs) {
            const parsed = parseActivity(input);
            expect(['known', 'unknown', 'invalid', 'dropped']).toContain(parsed.kind);
            seen.add(parsed.kind);
        }
        // The generator is only useful if it reaches every branch.
        expect([...seen].sort()).toEqual(['dropped', 'invalid', 'known', 'unknown']);
    });

    it('ActivityPageReader never throws and accounts for every item', () => {
        for (let start = 0; start < inputs.length; start += 40) {
            const items = inputs.slice(start, start + 40);
            const page = ActivityPageReader.parse({ items, nextCursor: null });
            expect(page.items.length + page.dropped).toBe(items.length);
        }
    });

    it('EngineEventReader never throws', () => {
        for (const input of inputs) {
            expect(() => EngineEventReader.safeParse(input)).not.toThrow();
            expect(() => EngineEventReader.safeParse({ type: 'activity', activity: input })).not.toThrow();
        }
    });
});
