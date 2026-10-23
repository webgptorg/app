import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';

import { HANDSHAKE_FAILURES } from '../tunnel/reject-mapping';
import type { RefusalReason } from './reason-counters';
import { REFUSAL_REASONS, STREAM_RESET_REASONS, TUNNEL_TERMINATION_REASONS } from './reason-counters';

export type MetricType = 'counter' | 'gauge' | 'histogram';

/**
 * One metric family. Every label has a closed list of values, so the number of series is fixed when the relay starts:
 * a label that could carry an engine ID, a hostname, an IP or anything about an account cannot be declared here.
 */
export interface MetricDefinition {
    readonly type: MetricType;
    readonly help: string;
    readonly labels: Readonly<Record<string, readonly string[]>>;
    /** Upper bounds in seconds, ascending; histograms only. */
    readonly buckets?: readonly number[];
}

/** How the browser listener ended up handling a connection (I-04); `limit` is any refusal for a limit or budget. */
export const BROWSER_OUTCOMES = ['routed', 'own-hostname', 'unknown-sni', 'no-sni', 'invalid', 'limit'] as const;
export type BrowserOutcome = (typeof BROWSER_OUTCOMES)[number];

/** `fresh`: answered from the cache; `miss`: the source answered; `stale`: the source failed and an old entry answered. */
export const REGISTRY_RESULTS = ['fresh', 'stale', 'miss', 'error'] as const;
export type RegistryResult = (typeof REGISTRY_RESULTS)[number];

export const TRAFFIC_DIRECTIONS = ['in', 'out'] as const;

const CLOSE_CODE_NAMES: ReadonlyMap<number, string> = new Map([
    [1000, 'normal'],
    [1001, 'going-away'],
    [1006, 'abnormal'],
    ...Object.entries(TUNNEL_CLOSE_CODE).map(([name, code]): [number, string] => [
        code,
        name.toLowerCase().replaceAll('_', '-'),
    ]),
]);
export const DISCONNECT_CODES = [...CLOSE_CODE_NAMES.values(), 'other'] as const;

/** A WebSocket close code as a label value; codes outside the known set share `other`. */
export function disconnectCode(code: number): string {
    return CLOSE_CODE_NAMES.get(code) ?? 'other';
}

/** Which outcome each refusal reason counts as in `ptbk_relay_browser_connections_total`. */
export function refusalOutcome(reason: RefusalReason): BrowserOutcome {
    switch (reason) {
        case 'no-sni':
            return 'no-sni';
        case 'unknown-host':
        case 'engine-offline':
            return 'unknown-sni';
        case 'malformed':
        case 'too-large':
        case 'timeout':
            return 'invalid';
        case 'evicted':
        case 'global-limit':
        case 'ip-limit':
        case 'ipv6-56-limit':
        case 'ipv6-48-limit':
        case 'ip-rate':
        case 'memory-limit':
        case 'engine-streams':
        case 'engine-rate':
            return 'limit';
    }
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/**
 * Every series the relay exposes on `GET /metrics` (I-04), aggregated over all engines and browsers. Adding a label
 * whose values depend on engines, hostnames, addresses or accounts is a review blocker; the label-cardinality test
 * enforces the closed lists.
 */
export const RELAY_METRICS = {
    ptbk_relay_tunnels_active: { type: 'gauge', help: 'Engine tunnels connected now.', labels: {} },
    ptbk_relay_tunnel_connects_total: { type: 'counter', help: 'Tunnels that completed the handshake.', labels: {} },
    ptbk_relay_tunnel_disconnects_total: {
        type: 'counter',
        help: 'Connected tunnels that closed, by WebSocket close code.',
        labels: { code: DISCONNECT_CODES },
    },
    ptbk_relay_tunnel_handshake_failures_total: {
        type: 'counter',
        help: 'Tunnel handshakes refused (authentication, limits, timeouts), by internal reason.',
        labels: { reason: HANDSHAKE_FAILURES },
    },
    ptbk_relay_tunnel_terminations_total: {
        type: 'counter',
        help: 'Tunnels the relay cut on its own, by reason.',
        labels: { reason: TUNNEL_TERMINATION_REASONS },
    },
    ptbk_relay_browser_connections_active: {
        type: 'gauge',
        help: 'Open connections on the listener, tunnels to the own hostname included.',
        labels: {},
    },
    ptbk_relay_browser_connections_pending: {
        type: 'gauge',
        help: 'Open connections whose ClientHello is not judged yet.',
        labels: {},
    },
    ptbk_relay_browser_connections_total: {
        type: 'counter',
        help: 'Connections the listener judged, by outcome.',
        labels: { outcome: BROWSER_OUTCOMES },
    },
    ptbk_relay_browser_refusals_total: {
        type: 'counter',
        help: 'Connections closed without a byte written, by reason.',
        labels: { reason: REFUSAL_REASONS },
    },
    ptbk_relay_stream_resets_total: {
        type: 'counter',
        help: 'Browser streams the relay reset on its own, by reason.',
        labels: { reason: STREAM_RESET_REASONS },
    },
    ptbk_relay_bytes_total: {
        type: 'counter',
        help: 'Bytes relayed between browsers and engines; in is towards engines.',
        labels: { direction: TRAFFIC_DIRECTIONS },
    },
    ptbk_relay_stream_open_seconds: {
        type: 'histogram',
        help: "From a browser's ClientHello to the engine's first byte on the new stream.",
        labels: {},
        buckets: LATENCY_BUCKETS,
    },
    ptbk_relay_registry_lookups_total: {
        type: 'counter',
        help: 'Registry lookups by result: fresh from the cache, miss answered by the source, stale or error.',
        labels: { result: REGISTRY_RESULTS },
    },
    ptbk_relay_registry_source_seconds: {
        type: 'histogram',
        help: 'How long the registry source took to answer, timeouts included.',
        labels: {},
        buckets: LATENCY_BUCKETS,
    },
    ptbk_relay_memory_budget_used_bytes: {
        type: 'gauge',
        help: 'Bytes held for others against RELAY_MEMORY_BUDGET_BYTES.',
        labels: {},
    },
    ptbk_relay_process_resident_memory_bytes: { type: 'gauge', help: 'Resident set size.', labels: {} },
    ptbk_relay_process_heap_used_bytes: { type: 'gauge', help: 'V8 heap in use.', labels: {} },
    ptbk_relay_process_open_fds: { type: 'gauge', help: 'Open file descriptors.', labels: {} },
    ptbk_relay_event_loop_lag_seconds: {
        type: 'gauge',
        help: 'Largest event loop delay since the previous scrape.',
        labels: {},
    },
    ptbk_relay_process_start_time_seconds: {
        type: 'gauge',
        help: 'When the process started, in Unix seconds.',
        labels: {},
    },
    ptbk_relay_certificate_expiry_timestamp_seconds: {
        type: 'gauge',
        help: "When the relay's own certificate expires, in Unix seconds.",
        labels: {},
    },
} as const satisfies Readonly<Record<string, MetricDefinition>>;

export type RelayMetricName = keyof typeof RELAY_METRICS;
type Definition<N extends RelayMetricName> = (typeof RELAY_METRICS)[N];
type NamesOfType<T extends MetricType> = {
    [N in RelayMetricName]: Definition<N>['type'] extends T ? N : never;
}[RelayMetricName];

export type CounterName = NamesOfType<'counter'>;
export type GaugeName = NamesOfType<'gauge'>;
export type HistogramName = NamesOfType<'histogram'>;

export type MetricLabels<N extends RelayMetricName> = {
    readonly [L in keyof Definition<N>['labels']]: Definition<N>['labels'][L] extends readonly (infer V extends
        string)[]
        ? V
        : never;
};

/** What relay code records; gauges and reason counters are read when the metrics are rendered. */
export interface Metrics {
    count<N extends CounterName>(name: N, labels: MetricLabels<N>, value?: number): void;
    /** `value` in seconds. */
    observe<N extends HistogramName>(name: N, labels: MetricLabels<N>, value: number): void;
}
