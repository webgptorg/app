import { readFileSync } from 'node:fs';

import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createCertSpotterSource } from './certspotter-source';
import { createCrtShSource } from './crtsh-source';
import { runCtWatch } from '../../domain/abuse/ct-watch';
import { createMemoryCtStore } from '../../testing/memory-ct-store';
import { createMemoryMonitor, createMonitoringTestDeps } from '../../testing/test-monitoring';

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url).pathname, 'utf8');
const CRTSH = fixture('crtsh-engines.json');
const CERTSPOTTER = fixture('certspotter-engines.json');
const signal = new AbortController().signal;

/** Both sources' recorded answers through the real adapters; nothing leaves the process. */
type Answer = (init: RequestInit) => Promise<Response>;

function setUp(answers: { readonly crtsh: Answer; readonly certspotter: Answer }) {
    const test = createMonitoringTestDeps(Date.UTC(2026, 9, 23, 12));
    const store = createMemoryCtStore();
    store.engineHostnames.add('k3v6xq2mfz4pd7h5wn2rbtcayu.engines.ptbk.test');
    store.engineHostnames.add('abcdefghijklmnopqrstuvwxyz.engines.ptbk.test');
    const monitor = createMemoryMonitor();
    let certspotterCalls = 0;
    const deps = {
        engineDomain: Hostname.parse('engines.ptbk.test'),
        sources: [
            createCrtShSource({ userAgent: 'test', fetch: (_url, init) => answers.crtsh(init) }),
            createCertSpotterSource({
                userAgent: 'test',
                apiKey: null,
                // The fixture is one page; the next one is empty, as the API answers past the end.
                fetch: (_url, init) =>
                    certspotterCalls++ % 2 === 0 ? answers.certspotter(init) : Promise.resolve(Response.json([])),
            }),
        ],
        store,
        monitor,
        settings: { allowedIssuers: ["Let's Encrypt"], issuanceSpike: { limit: 5, days: 7 }, sourceTimeoutMs: 50 },
        clock: test.clock,
        logger: test.logger,
    };
    return { deps, store, monitor, test };
}

describe('CT watch on recorded crt.sh and Cert Spotter answers', () => {
    it('alerts once each for the wildcard, the foreign issuer and the unknown hostname', async () => {
        const { deps, store, monitor } = setUp({
            crtsh: () => Promise.resolve(new Response(CRTSH)),
            certspotter: () => Promise.resolve(new Response(CERTSPOTTER)),
        });
        await runCtWatch(deps, signal);
        await runCtWatch(deps, signal);
        const alerts = await monitor.alerts();
        expect(alerts.map((alert) => alert.rule)).toEqual(['ct-wildcard', 'ct-foreign-issuer', 'ct-unknown-hostname']);
        // crt.sh's precertificate and certificate, and the same issuances in Cert Spotter, are one row each.
        expect(store.certs.size).toBe(5);
        const flagged = [...store.certs.values()].filter((cert) => cert.alert.length > 0);
        expect(flagged.map((cert) => [cert.hostnames, cert.alert])).toEqual([
            [['*.engines.ptbk.test'], ['wildcard']],
            [['abcdefghijklmnopqrstuvwxyz.engines.ptbk.test'], ['foreign-issuer']],
            [['login.engines.ptbk.test'], ['unknown-hostname']],
        ]);
        expect(alerts.map((alert) => alert.subject)).toEqual(flagged.map((cert) => cert.issuanceSha256));
    });

    it('does not fail the run when one source times out', async () => {
        const { deps, monitor, test } = setUp({
            crtsh: () => Promise.resolve(new Response(CRTSH)),
            // Like fetch: pending until its signal aborts, which the watch's per-source timeout does.
            certspotter: (init) =>
                new Promise((_, reject) => {
                    init.signal?.addEventListener('abort', () => {
                        reject(init.signal?.reason as Error);
                    });
                }),
        });
        await expect(runCtWatch(deps, signal)).resolves.toBeUndefined();
        expect(await monitor.alerts()).toHaveLength(3);
        expect(test.logger.entries).toContainEqual({
            level: 'warn',
            event: 'ct.source-failed',
            fields: { source: 'certspotter', problem: 'TimeoutError' },
        });
    });
});
