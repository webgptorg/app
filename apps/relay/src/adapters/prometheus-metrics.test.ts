import { describe, expect, it } from 'vitest';

import type { MetricDefinition } from '../domain/metrics/catalog';
import { parseExposition } from '../testing/prometheus-text';
import { createPrometheusMetrics } from './prometheus-metrics';

const CATALOG = {
    test_events_total: { type: 'counter', help: 'Events.\nWith "a" back\\slash.', labels: { kind: ['a', 'b'] } },
    test_level: { type: 'gauge', help: 'A level.', labels: {} },
    test_unset: { type: 'gauge', help: 'Never set.', labels: {} },
    test_wait_seconds: { type: 'histogram', help: 'Waits.', labels: {}, buckets: [0.1, 1] },
} as const satisfies Readonly<Record<string, MetricDefinition>>;

// The adapter is typed for the relay's catalog; these tests drive it with a small one.
interface UntypedMetrics {
    count(name: string, labels: Record<string, string>, value?: number): void;
    observe(name: string, labels: Record<string, string>, value: number): void;
    set(name: string, labels: Record<string, string>, value: number): void;
    render(): string;
}
const untyped = (): UntypedMetrics => createPrometheusMetrics(CATALOG);

describe('createPrometheusMetrics', () => {
    it('renders every declared series from zero, histograms cumulatively, and leaves out unset gauges', () => {
        const metrics = untyped();
        metrics.count('test_events_total', { kind: 'a' });
        metrics.count('test_events_total', { kind: 'a' }, 2);
        metrics.set('test_level', {}, 7);
        metrics.observe('test_wait_seconds', {}, 0.05);
        metrics.observe('test_wait_seconds', {}, 0.5);
        metrics.observe('test_wait_seconds', {}, 5);
        expect(metrics.render()).toBe(
            [
                '# HELP test_events_total Events.\\nWith "a" back\\\\slash.',
                '# TYPE test_events_total counter',
                'test_events_total{kind="a"} 3',
                'test_events_total{kind="b"} 0',
                '# HELP test_level A level.',
                '# TYPE test_level gauge',
                'test_level 7',
                '# HELP test_wait_seconds Waits.',
                '# TYPE test_wait_seconds histogram',
                'test_wait_seconds_bucket{le="0.1"} 1',
                'test_wait_seconds_bucket{le="1"} 2',
                'test_wait_seconds_bucket{le="+Inf"} 3',
                'test_wait_seconds_sum 5.55',
                'test_wait_seconds_count 3',
                '',
            ].join('\n'),
        );
        expect(parseExposition(metrics.render()).value('test_events_total', { kind: 'a' })).toBe(3);
    });

    it('refuses a label value, a label or a metric that was not declared, so no new series can appear', () => {
        const metrics = untyped();
        expect(() => {
            metrics.count('test_events_total', { kind: 'engine-123' });
        }).toThrow(RangeError);
        expect(() => {
            metrics.count('test_events_total', { kind: 'a', engine: 'x' });
        }).toThrow(RangeError);
        expect(() => {
            metrics.count('test_other_total', {});
        }).toThrow(RangeError);
        expect(() => {
            metrics.set('test_level', { kind: 'a' }, 1);
        }).toThrow(RangeError);
        expect(metrics.render()).not.toContain('engine');
    });

    it('refuses to count down', () => {
        const metrics = untyped();
        expect(() => {
            metrics.count('test_events_total', { kind: 'a' }, -1);
        }).toThrow('a counter only grows');
        expect(() => {
            metrics.count('test_events_total', { kind: 'a' }, Number.NaN);
        }).toThrow(RangeError);
    });

    it('writes NaN and infinities in the exposition format', () => {
        const metrics = untyped();
        metrics.set('test_level', {}, Number.NaN);
        expect(metrics.render()).toContain('test_level NaN\n');
        metrics.set('test_level', {}, Infinity);
        expect(metrics.render()).toContain('test_level +Inf\n');
        metrics.set('test_level', {}, -Infinity);
        expect(metrics.render()).toContain('test_level -Inf\n');
    });
});
