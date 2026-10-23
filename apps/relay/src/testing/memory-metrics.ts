import type { CounterName, HistogramName, MetricLabels, Metrics } from '../domain/metrics/catalog';

export interface RecordedMetric {
    readonly kind: 'count' | 'observe';
    readonly name: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly value: number;
}

/** The fake `Metrics` port: records every call for assertions. */
export interface MemoryMetrics extends Metrics {
    readonly records: readonly RecordedMetric[];
    /** Sum of the counts of `name` whose labels include `labels`. */
    total<N extends CounterName>(name: N, labels?: Partial<MetricLabels<N>>): number;
    observations(name: HistogramName): readonly number[];
}

export function createMemoryMetrics(): MemoryMetrics {
    const records: RecordedMetric[] = [];
    const matches = (record: RecordedMetric, labels: Readonly<Record<string, unknown>>): boolean =>
        Object.entries(labels).every(([label, value]) => record.labels[label] === value);
    return {
        records,
        count(name, labels, value = 1) {
            records.push({ kind: 'count', name, labels, value });
        },
        observe(name, labels, value) {
            records.push({ kind: 'observe', name, labels, value });
        },
        total(name, labels = {}) {
            return records
                .filter((record) => record.kind === 'count' && record.name === name && matches(record, labels))
                .reduce((sum, record) => sum + record.value, 0);
        },
        observations(name) {
            return records
                .filter((record) => record.kind === 'observe' && record.name === name)
                .map((record) => record.value);
        },
    };
}
