import { X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { request } from 'node:https';

import type { RelayMessage, TunnelChallenge } from '@ptbk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RELAY_METRICS } from '../src/domain/metrics/catalog';
import type { RawClient } from '../src/testing/client-hello';
import { captureClientHello, rawClient } from '../src/testing/client-hello';
import { serveEngineStreams } from '../src/testing/engine-streams';
import { createTestEngine } from '../src/testing/engines';
import { parseExposition } from '../src/testing/prometheus-text';
import type { RelayHarness } from '../src/testing/relay-harness';
import { RELAY_ID, startHarness } from '../src/testing/relay-harness';

const METRICS_TOKEN = `ptbk_mt_${'Q'.repeat(43)}`;

function challengeOf(message: RelayMessage): TunnelChallenge {
    if (message.type !== 'challenge') throw new Error(`expected a challenge, got ${message.type}`);
    return message;
}

function scrape(harness: RelayHarness, authorization?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                host: '127.0.0.1',
                port: harness.port,
                path: '/metrics',
                servername: RELAY_ID,
                ca: harness.certificate.cert,
                headers: authorization === undefined ? {} : { authorization },
                agent: false,
            },
            (response) => {
                let body = '';
                response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
                response.on('end', () => {
                    resolve({ status: response.statusCode ?? 0, body });
                });
            },
        );
        outgoing.on('error', reject);
        outgoing.end();
    });
}

describe('GET /metrics on the relay hostname', () => {
    let harness: RelayHarness | undefined;
    const clients: RawClient[] = [];

    afterEach(async () => {
        for (const client of clients.splice(0)) client.socket.destroy();
        await harness?.close();
        harness = undefined;
    });

    function browser(relay: RelayHarness): RawClient {
        const client = rawClient(relay.port);
        clients.push(client);
        return client;
    }

    it('is 404 without a metrics token configured, and 401 without the right token', async () => {
        harness = await startHarness();
        await expect(scrape(harness, `Bearer ${METRICS_TOKEN}`)).resolves.toMatchObject({ status: 404 });
        await harness.close();
        harness = await startHarness({ env: { RELAY_METRICS_TOKEN: METRICS_TOKEN } });
        await expect(scrape(harness)).resolves.toEqual({ status: 401, body: '' });
        await expect(scrape(harness, `Bearer ${METRICS_TOKEN.slice(0, -1)}R`)).resolves.toEqual({
            status: 401,
            body: '',
        });
    });

    it('exposes every documented series, aggregated, without an engine ID, hostname or IP', async () => {
        harness = await startHarness({ env: { RELAY_METRICS_TOKEN: METRICS_TOKEN } });
        const engine = await createTestEngine(160);
        harness.registry.set(engine.engineId, engine.entry);
        const client = harness.connect(engine);
        await client.authenticate(challengeOf(await client.nextMessage()));
        expect(await client.nextMessage()).toMatchObject({ type: 'ready' });
        const streams = serveEngineStreams(client.ws);

        const hello = await captureClientHello(engine.defaultHostname);
        const routed = browser(harness);
        routed.socket.write(hello);
        const stream = await streams.next();
        stream.write(Buffer.from('engine says hi'));
        await vi.waitFor(() => {
            expect(routed.received().toString()).toBe('engine says hi');
        });
        browser(harness).socket.write(await captureClientHello());
        browser(harness).socket.write(await captureClientHello('nobody.example'));
        await vi.waitFor(() => {
            expect(harness?.listener.browser.refusals()).toMatchObject({ 'no-sni': 1, 'unknown-host': 1 });
        });

        const { status, body } = await scrape(harness, `Bearer ${METRICS_TOKEN}`);
        expect(status).toBe(200);
        // `promtool check metrics` runs over this sample (docs/runbooks/observability.md).
        const sample = process.env['RELAY_METRICS_SAMPLE'];
        if (sample !== undefined && sample !== '') writeFileSync(sample, body);

        const metrics = parseExposition(body);
        expect([...metrics.types.keys()].sort()).toEqual(Object.keys(RELAY_METRICS).sort());
        expect(metrics.value('ptbk_relay_tunnels_active')).toBe(1);
        expect(metrics.value('ptbk_relay_tunnel_connects_total')).toBe(1);
        expect(metrics.value('ptbk_relay_browser_connections_total', { outcome: 'routed' })).toBe(1);
        expect(metrics.value('ptbk_relay_browser_connections_total', { outcome: 'no-sni' })).toBe(1);
        expect(metrics.value('ptbk_relay_browser_connections_total', { outcome: 'unknown-sni' })).toBe(1);
        // The scrape itself is a connection to the relay's own hostname.
        expect(metrics.value('ptbk_relay_browser_connections_total', { outcome: 'own-hostname' })).toBe(2);
        expect(metrics.value('ptbk_relay_browser_refusals_total', { reason: 'unknown-host' })).toBe(1);
        expect(metrics.value('ptbk_relay_bytes_total', { direction: 'in' })).toBe(hello.length);
        expect(metrics.value('ptbk_relay_bytes_total', { direction: 'out' })).toBe('engine says hi'.length);
        expect(metrics.value('ptbk_relay_stream_open_seconds_count')).toBe(1);
        expect(metrics.value('ptbk_relay_stream_open_seconds_bucket', { le: '+Inf' })).toBe(1);
        expect(metrics.value('ptbk_relay_registry_lookups_total', { result: 'miss' })).toBe(1);
        expect(metrics.value('ptbk_relay_registry_source_seconds_count')).toBe(1);
        expect(metrics.value('ptbk_relay_browser_connections_active')).toBeGreaterThanOrEqual(2);
        expect(metrics.value('ptbk_relay_process_resident_memory_bytes')).toBeGreaterThan(0);
        expect(metrics.value('ptbk_relay_event_loop_lag_seconds')).toBeGreaterThanOrEqual(0);
        expect(metrics.value('ptbk_relay_certificate_expiry_timestamp_seconds')).toBe(
            Math.floor(new X509Certificate(harness.certificate.cert).validToDate.getTime() / 1000),
        );

        for (const forbidden of [engine.engineId, engine.defaultHostname, RELAY_ID, 'nobody.example', '127.0.0.1']) {
            expect(body).not.toContain(forbidden);
        }
        for (const { name, labels } of metrics.samples) {
            const family = name.replace(/_(bucket|sum|count)$/, '');
            const definition = RELAY_METRICS[(family in RELAY_METRICS ? family : name) as keyof typeof RELAY_METRICS];
            for (const [label, value] of Object.entries(labels)) {
                if (label === 'le') continue;
                const allowed: readonly string[] | undefined = (
                    definition.labels as Readonly<Record<string, readonly string[]>>
                )[label];
                expect(allowed, `${name}{${label}}`).toContain(value);
            }
        }
    });
});
