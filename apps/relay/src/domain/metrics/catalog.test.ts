import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { MetricDefinition } from './catalog';
import { BROWSER_OUTCOMES, RELAY_METRICS, disconnectCode, refusalOutcome } from './catalog';
import { REFUSAL_REASONS } from './reason-counters';

/** The only label names a relay series may have: each a closed list, none of them about who or where. */
const ALLOWED_LABELS = new Set(['code', 'reason', 'outcome', 'result', 'direction']);
const ENGINE_LEVEL = /engine|host|sni|domain|ip|addr|peer|client|browser|account|org|user|email|id$/i;
/** Fixed and small: a scrape stays a few kilobytes and a new label value is a deliberate change. */
const MAX_VALUES_PER_LABEL = 32;
const MAX_SERIES = 250;

const definitions = Object.entries(RELAY_METRICS) as [string, MetricDefinition][];

function seriesOf(definition: MetricDefinition): number {
    const combinations = Object.values(definition.labels).reduce((product, values) => product * values.length, 1);
    // A histogram writes a bucket per bound, +Inf, _sum and _count.
    return definition.type === 'histogram' ? combinations * ((definition.buckets?.length ?? 0) + 3) : combinations;
}

describe('relay metric catalog: label cardinality', () => {
    it('names every family ptbk_relay_*, counters *_total, with help text', () => {
        for (const [name, definition] of definitions) {
            expect(name).toMatch(/^ptbk_relay_[a-z0-9_]+$/);
            expect(name.endsWith('_total'), name).toBe(definition.type === 'counter');
            expect(definition.help.length, name).toBeGreaterThan(10);
        }
    });

    it('allows only fixed labels with closed, small lists of plain values', () => {
        for (const [name, definition] of definitions) {
            for (const [label, values] of Object.entries(definition.labels)) {
                expect(ALLOWED_LABELS.has(label), `${name}{${label}}`).toBe(true);
                expect(label).not.toMatch(ENGINE_LEVEL);
                expect(values.length, `${name}{${label}}`).toBeLessThanOrEqual(MAX_VALUES_PER_LABEL);
                expect(new Set(values).size, `${name}{${label}}`).toBe(values.length);
                for (const value of values) expect(value, `${name}{${label}}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
            }
        }
    });

    it('keeps the whole relay to a bounded number of series, whatever the number of engines', () => {
        const total = definitions.reduce((sum, [, definition]) => sum + seriesOf(definition), 0);
        expect(total).toBeLessThanOrEqual(MAX_SERIES);
    });

    it('gives histograms ascending buckets in seconds', () => {
        for (const [name, definition] of definitions.filter(([, d]) => d.type === 'histogram')) {
            const buckets = definition.buckets ?? [];
            expect(buckets.length, name).toBeGreaterThan(0);
            expect(
                [...buckets].sort((a, b) => a - b),
                name,
            ).toEqual(buckets);
        }
    });
});

describe('disconnectCode', () => {
    it('names the tunnel close codes and the common WebSocket ones, and folds the rest into other', () => {
        expect(disconnectCode(1000)).toBe('normal');
        expect(disconnectCode(1006)).toBe('abnormal');
        expect(disconnectCode(TUNNEL_CLOSE_CODE.SHUTTING_DOWN)).toBe('shutting-down');
        expect(disconnectCode(TUNNEL_CLOSE_CODE.FRAME_BUDGET)).toBe('frame-budget');
        expect(disconnectCode(4999)).toBe('other');
        expect(disconnectCode(3000)).toBe('other');
    });
});

describe('refusalOutcome', () => {
    it('puts every refusal reason into one of the outcomes', () => {
        const outcomes = Object.fromEntries(REFUSAL_REASONS.map((reason) => [reason, refusalOutcome(reason)]));
        for (const outcome of Object.values(outcomes)) expect(BROWSER_OUTCOMES).toContain(outcome);
        expect(outcomes).toMatchObject({
            'no-sni': 'no-sni',
            'unknown-host': 'unknown-sni',
            'engine-offline': 'unknown-sni',
            malformed: 'invalid',
            timeout: 'invalid',
            'ip-rate': 'limit',
            'memory-limit': 'limit',
        });
    });
});
