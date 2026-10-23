import { describe, expect, it } from 'vitest';

import {
    RELAY_HEALTH_SERIES,
    RELAY_OUTCOME_SERIES,
    parseRelaySample,
    registryLookups,
    seriesValues,
} from './relay-sample';

const SCRAPE = `# HELP ptbk_relay_tunnels_active Engine tunnels connected now.
# TYPE ptbk_relay_tunnels_active gauge
ptbk_relay_tunnels_active 3
ptbk_relay_bytes_total{direction="in"} 1024
ptbk_relay_bytes_total{direction="out"} 2048 1700000000000
ptbk_relay_registry_lookups_total{result="fresh"} 10
ptbk_relay_registry_lookups_total{result="miss"} 2
ptbk_relay_registry_lookups_total{result="stale"} 1
ptbk_relay_registry_lookups_total{result="error"} 0
ptbk_relay_browser_connections_total{outcome="routed"} 7
ptbk_relay_event_loop_lag_seconds NaN
ptbk_relay_process_open_fds +Inf
ptbk_relay_stream_open_seconds_bucket{le="0.1"} 1
ptbk_relay_tunnels_by_engine{engine="aaaaaaaaaaaaaaaaaaaaaaaaaa"} 1
ptbk_relay_bytes_total{direction="in",engine="aaaaaaaaaaaaaaaaaaaaaaaaaa"} 99
ptbk_relay_tunnel_connects_total not-a-number
garbage line
{not a sample}
ptbk_relay_memory_budget_used_bytes{} 512
`;

describe('parseRelaySample', () => {
    it('keeps only the kept series and drops anything a relay adds, labels included', () => {
        const sample = parseRelaySample(SCRAPE);
        expect(Object.fromEntries(sample.values)).toEqual({
            ptbk_relay_tunnels_active: 3,
            'ptbk_relay_bytes_total{direction="in"}': 1024,
            'ptbk_relay_bytes_total{direction="out"}': 2048,
            'ptbk_relay_registry_lookups_total{result="fresh"}': 10,
            'ptbk_relay_registry_lookups_total{result="miss"}': 2,
            'ptbk_relay_registry_lookups_total{result="stale"}': 1,
            'ptbk_relay_registry_lookups_total{result="error"}': 0,
            'ptbk_relay_browser_connections_total{outcome="routed"}': 7,
            ptbk_relay_event_loop_lag_seconds: Number.NaN,
            ptbk_relay_process_open_fds: Infinity,
            ptbk_relay_memory_budget_used_bytes: 512,
        });
        expect(JSON.stringify([...sample.values.keys()])).not.toContain('aaaaaaaaaa');
    });

    it('reads -Inf', () => {
        expect(parseRelaySample('ptbk_relay_tunnels_active -Inf\n').values.get('ptbk_relay_tunnels_active')).toBe(
            -Infinity,
        );
    });
});

describe('seriesValues', () => {
    it('writes every kept series in order, 0 for missing or non-finite values, at most 20 per point', () => {
        const sample = parseRelaySample(SCRAPE);
        const health = seriesValues(sample, RELAY_HEALTH_SERIES);
        expect(health).toHaveLength(RELAY_HEALTH_SERIES.length);
        expect(health[0]).toBe(3);
        expect(health[RELAY_HEALTH_SERIES.indexOf('ptbk_relay_event_loop_lag_seconds')]).toBe(0);
        expect(health[RELAY_HEALTH_SERIES.indexOf('ptbk_relay_process_open_fds')]).toBe(0);
        expect(RELAY_HEALTH_SERIES.length).toBeLessThanOrEqual(20);
        expect(RELAY_OUTCOME_SERIES.length).toBeLessThanOrEqual(20);
        expect(seriesValues(sample, RELAY_OUTCOME_SERIES)[0]).toBe(7);
    });
});

describe('registryLookups', () => {
    it('reads the four results, or null when one is missing', () => {
        expect(registryLookups(parseRelaySample(SCRAPE))).toEqual({ fresh: 10, miss: 2, stale: 1, error: 0 });
        expect(registryLookups(parseRelaySample('ptbk_relay_tunnels_active 1\n'))).toBeNull();
    });
});
