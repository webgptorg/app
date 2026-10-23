/** A relay's `/metrics` answer is a few kilobytes; anything far larger is not ours to parse. */
export const MAX_SCRAPE_BYTES = 256 * 1024;

const REGISTRY_RESULTS = ['fresh', 'miss', 'stale', 'error'] as const;
const BROWSER_OUTCOMES = ['routed', 'own-hostname', 'unknown-sni', 'no-sni', 'invalid', 'limit'] as const;
const HANDSHAKE_FAILURES = [
    'unknown-engine',
    'suspended',
    'bad-signature',
    'id-key-mismatch',
    'registry-unavailable',
    'unsupported-version',
    'malformed',
    'rate-limited',
    'timeout',
] as const;

const labelled = (family: string, label: string, values: readonly string[]): string[] =>
    values.map((value) => `${family}{${label}="${value}"}`);

/**
 * The relay series the dashboard keeps, in the order they are written to Analytics Engine (two data points per relay
 * and scrape, at most 20 values each). Only these are read from a scrape: whatever else a relay sends, even a label a
 * compromised relay invents, is never stored. The relay's own catalog (apps/relay, `RELAY_METRICS`) is the contract.
 */
export const RELAY_HEALTH_SERIES = [
    'ptbk_relay_tunnels_active',
    'ptbk_relay_tunnel_connects_total',
    'ptbk_relay_browser_connections_active',
    'ptbk_relay_browser_connections_pending',
    ...labelled('ptbk_relay_bytes_total', 'direction', ['in', 'out']),
    ...labelled('ptbk_relay_registry_lookups_total', 'result', REGISTRY_RESULTS),
    'ptbk_relay_registry_source_seconds_sum',
    'ptbk_relay_registry_source_seconds_count',
    'ptbk_relay_stream_open_seconds_sum',
    'ptbk_relay_stream_open_seconds_count',
    'ptbk_relay_memory_budget_used_bytes',
    'ptbk_relay_process_resident_memory_bytes',
    'ptbk_relay_process_open_fds',
    'ptbk_relay_event_loop_lag_seconds',
    'ptbk_relay_certificate_expiry_timestamp_seconds',
    'ptbk_relay_process_start_time_seconds',
] as const;

export const RELAY_OUTCOME_SERIES = [
    ...labelled('ptbk_relay_browser_connections_total', 'outcome', BROWSER_OUTCOMES),
    ...labelled('ptbk_relay_tunnel_handshake_failures_total', 'reason', HANDSHAKE_FAILURES),
] as const;

const KEPT: ReadonlySet<string> = new Set([...RELAY_HEALTH_SERIES, ...RELAY_OUTCOME_SERIES]);

/** What one successful scrape of a relay says, reduced to the kept series. */
export interface RelaySample {
    /** Kept series present in the scrape; a missing one is absent, never guessed. */
    readonly values: ReadonlyMap<string, number>;
}

const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (\S+)(?: \d+)?$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function parseValue(text: string): number | null {
    if (text === '+Inf') return Infinity;
    if (text === '-Inf') return -Infinity;
    const value = Number(text);
    return text === 'NaN' || !Number.isNaN(value) ? value : null;
}

/** `family{label="value"}` with labels sorted by name, the form the kept series are named in. */
function canonicalKey(family: string, labelText: string | undefined): string {
    if (labelText === undefined || labelText === '{}') return family;
    // Both groups always match when the pattern does.
    const labels = [...labelText.matchAll(LABEL)].map((match) => `${String(match[1])}="${String(match[2])}"`).sort();
    return `${family}{${labels.join(',')}}`;
}

/** Reads the Prometheus text format leniently (a relay may add series) and keeps only {@link RELAY_HEALTH_SERIES} and {@link RELAY_OUTCOME_SERIES}. */
export function parseRelaySample(text: string): RelaySample {
    const values = new Map<string, number>();
    for (const line of text.split('\n')) {
        if (line === '' || line.startsWith('#')) continue;
        const match = SAMPLE_LINE.exec(line);
        if (match === null) continue;
        const key = canonicalKey(String(match[1]), match[2]);
        const value = parseValue(String(match[3]));
        if (KEPT.has(key) && value !== null) values.set(key, value);
    }
    return { values };
}

/** The kept values of `series` in order, 0 for a missing one, for an Analytics Engine data point. */
export function seriesValues(sample: RelaySample, series: readonly string[]): number[] {
    return series.map((key) => {
        const value = sample.values.get(key) ?? 0;
        return Number.isFinite(value) ? value : 0;
    });
}

/** Registry lookups so far, by result; null if the relay did not report them. */
export function registryLookups(
    sample: RelaySample,
): Readonly<Record<(typeof REGISTRY_RESULTS)[number], number>> | null {
    const entries = REGISTRY_RESULTS.map(
        (result) => [result, sample.values.get(`ptbk_relay_registry_lookups_total{result="${result}"}`)] as const,
    );
    if (entries.some(([, value]) => value === undefined)) return null;
    return Object.fromEntries(entries) as Record<(typeof REGISTRY_RESULTS)[number], number>;
}
