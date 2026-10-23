import type {
    MetricDefinition,
    MetricLabels,
    Metrics,
    RelayMetricName,
    CounterName,
    HistogramName,
} from '../domain/metrics/catalog';
import { RELAY_METRICS } from '../domain/metrics/catalog';

/** The Prometheus text exposition format, version 0.0.4. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface PrometheusMetrics extends Metrics {
    /** Gauges, and counters kept elsewhere (the reason counters), set from their sources just before `render`. */
    set<N extends RelayMetricName>(name: N, labels: MetricLabels<N>, value: number): void;
    render(): string;
}

interface HistogramSeries {
    readonly buckets: number[];
    sum: number;
    count: number;
}

type Labels = Readonly<Record<string, string>>;

function escapeLabelValue(value: string): string {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function escapeHelp(help: string): string {
    return help.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

function formatValue(value: number): string {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return '+Inf';
    if (value === -Infinity) return '-Inf';
    return String(value);
}

/** Every combination of the declared label values: the whole, fixed set of series of one family. */
function labelCombinations(definition: MetricDefinition): readonly Labels[] {
    return Object.entries(definition.labels).reduce<Labels[]>(
        (combinations, [label, values]) =>
            combinations.flatMap((combination) => values.map((value) => ({ ...combination, [label]: value }))),
        [{}],
    );
}

function seriesKey(definition: MetricDefinition, labels: Labels): string {
    return Object.keys(definition.labels)
        .map((label) => `${label}="${escapeLabelValue(labels[label] ?? '')}"`)
        .join(',');
}

function braces(key: string, extra?: string): string {
    const all = [key, extra].filter((part) => part !== undefined && part !== '').join(',');
    return all === '' ? '' : `{${all}}`;
}

/**
 * In-memory metrics for `GET /metrics`. Every series is created at start from the catalog's closed label lists, so a
 * label value outside them is a bug (it throws) and can never become a new series.
 */
export function createPrometheusMetrics(
    catalog: Readonly<Record<string, MetricDefinition>> = RELAY_METRICS,
): PrometheusMetrics {
    const values = new Map<string, Map<string, number | undefined>>();
    const histograms = new Map<string, Map<string, HistogramSeries>>();
    for (const [name, definition] of Object.entries(catalog)) {
        const keys = labelCombinations(definition).map((labels) => seriesKey(definition, labels));
        if (definition.type === 'histogram') {
            const bucketCount = definition.buckets?.length ?? 0;
            histograms.set(
                name,
                new Map(
                    keys.map((key) => [key, { buckets: new Array<number>(bucketCount).fill(0), sum: 0, count: 0 }]),
                ),
            );
        } else {
            // A gauge nobody has set (an unreadable source) is left out rather than shown as 0.
            values.set(name, new Map(keys.map((key) => [key, definition.type === 'counter' ? 0 : undefined])));
        }
    }

    function definitionOf(name: string): MetricDefinition {
        const definition = catalog[name];
        if (definition === undefined) throw new RangeError(`unknown metric ${name}`);
        return definition;
    }

    function keyOf(name: string, labels: Labels, family: ReadonlyMap<string, unknown> | undefined): string {
        const definition = definitionOf(name);
        const key = seriesKey(definition, labels);
        const declared = Object.keys(labels).every((label) => label in definition.labels);
        if (!declared || family?.has(key) !== true) throw new RangeError(`undeclared series of ${name}`);
        return key;
    }

    return {
        count(name: CounterName, labels: Labels, value = 1) {
            const family = values.get(name);
            const key = keyOf(name, labels, family);
            if (!Number.isFinite(value) || value < 0) throw new RangeError('a counter only grows');
            family?.set(key, (family.get(key) ?? 0) + value);
        },
        observe(name: HistogramName, labels: Labels, value: number) {
            const family = histograms.get(name);
            const series = family?.get(keyOf(name, labels, family));
            if (series === undefined) return;
            const bounds = definitionOf(name).buckets ?? [];
            bounds.forEach((bound, index) => {
                if (value <= bound) series.buckets[index] = (series.buckets[index] ?? 0) + 1;
            });
            series.sum += value;
            series.count += 1;
        },
        set(name: RelayMetricName, labels: Labels, value: number) {
            const family = values.get(name);
            family?.set(keyOf(name, labels, family), value);
        },
        render() {
            const lines: string[] = [];
            for (const [name, definition] of Object.entries(catalog)) {
                const header = [`# HELP ${name} ${escapeHelp(definition.help)}`, `# TYPE ${name} ${definition.type}`];
                const family = histograms.get(name);
                if (family !== undefined) {
                    lines.push(...header);
                    const bounds = definition.buckets ?? [];
                    for (const [key, series] of family) {
                        bounds.forEach((bound, index) => {
                            const le = `le="${formatValue(bound)}"`;
                            lines.push(`${name}_bucket${braces(key, le)} ${String(series.buckets[index] ?? 0)}`);
                        });
                        lines.push(`${name}_bucket${braces(key, 'le="+Inf"')} ${String(series.count)}`);
                        lines.push(`${name}_sum${braces(key)} ${formatValue(series.sum)}`);
                        lines.push(`${name}_count${braces(key)} ${String(series.count)}`);
                    }
                    continue;
                }
                const set = [...(values.get(name) ?? [])].filter(
                    (entry): entry is [string, number] => entry[1] !== undefined,
                );
                if (set.length === 0) continue;
                lines.push(...header, ...set.map(([key, value]) => `${name}${braces(key)} ${formatValue(value)}`));
            }
            return `${lines.join('\n')}\n`;
        },
    };
}
