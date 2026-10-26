import type { Hostname } from '@ptbk/protocol';

import type { RelayProbe, RelayProber } from '../../domain/monitoring/relay-prober';
import { MAX_SCRAPE_BYTES } from '../../domain/monitoring/relay-sample';
import { readCapped } from '../read-capped';

export interface FetchRelayProberOptions {
    readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
    /** The metrics token per relay ID (`RELAY_METRICS_TOKENS`). */
    readonly tokens: ReadonlyMap<Hostname, string>;
}

/**
 * HTTPS to the relay's own hostname, so the runtime verifies its certificate: a failed connect or handshake is `tls`.
 * Redirects are refused, so the token is never sent anywhere else.
 */
export function createFetchRelayProber(options: FetchRelayProberOptions): RelayProber {
    const get = (url: string, signal: AbortSignal, headers: Record<string, string> = {}) =>
        options.fetch(url, { method: 'GET', headers, redirect: 'manual', signal });

    async function probe(relayId: Hostname, signal: AbortSignal): Promise<RelayProbe> {
        const token = options.tokens.get(relayId);
        if (token === undefined) return { kind: 'down', reason: 'metrics' };
        const health = await get(`https://${relayId}/healthz`, signal);
        if (health.status !== 200) {
            await health.body?.cancel();
            return { kind: 'down', reason: 'healthz' };
        }
        if ((await readCapped(health, 64))?.trim() !== 'ok') return { kind: 'down', reason: 'healthz' };
        const metrics = await get(`https://${relayId}/metrics`, signal, { Authorization: `Bearer ${token}` });
        if (metrics.status !== 200) {
            await metrics.body?.cancel();
            return { kind: 'down', reason: 'metrics' };
        }
        const text = await readCapped(metrics, MAX_SCRAPE_BYTES);
        return text === null ? { kind: 'down', reason: 'metrics' } : { kind: 'up', metrics: text };
    }

    return {
        async probe(relayId, signal) {
            try {
                return await probe(relayId, signal);
            } catch {
                return { kind: 'down', reason: signal.aborted ? 'timeout' : 'tls' };
            }
        },
    };
}
