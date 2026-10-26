import { Hostname } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeCtSource, type FakeCtSource } from '../../testing/fake-ct-source';
import { createMemoryCtStore, type MemoryCtStore } from '../../testing/memory-ct-store';
import { createMemoryMonitor, createMonitoringTestDeps, type MonitoringTestDeps } from '../../testing/test-monitoring';
import type { CtIssuance } from './ct-log-source';
import { CT_RETENTION_MS, issuanceKey, MAX_CT_ALERTS_PER_RUN, runCtWatch, type CtWatchDeps } from './ct-watch';

const DOMAIN = Hostname.parse('engines.ptbk.test');
const NOW = Date.UTC(2026, 9, 23, 12);
const DAY = 86_400_000;
const LE = "C=US, O=Let's Encrypt, CN=R11";
const ENGINE = 'k3v6xq2mfz4pd7h5wn2rbtcayu.engines.ptbk.test';
const signal = new AbortController().signal;

function issuance(hostnames: readonly string[], overrides: Partial<CtIssuance> = {}): CtIssuance {
    return { hostnames, issuer: LE, notBefore: NOW - DAY, ...overrides };
}

describe('runCtWatch', () => {
    let test: MonitoringTestDeps;
    let store: MemoryCtStore;
    let crtsh: FakeCtSource;
    let certspotter: FakeCtSource;
    let monitor: ReturnType<typeof createMemoryMonitor>;
    let deps: CtWatchDeps;

    beforeEach(() => {
        test = createMonitoringTestDeps(NOW);
        store = createMemoryCtStore();
        store.engineHostnames.add(ENGINE);
        crtsh = createFakeCtSource('crt.sh');
        certspotter = createFakeCtSource('certspotter');
        monitor = createMemoryMonitor();
        deps = {
            engineDomain: DOMAIN,
            sources: [crtsh, certspotter],
            store,
            monitor,
            settings: { allowedIssuers: ["Let's Encrypt"], issuanceSpike: { limit: 3, days: 7 }, sourceTimeoutMs: 50 },
            clock: test.clock,
            logger: test.logger,
        };
    });

    async function alerts() {
        return (await monitor.alerts()).map((alert) => `${alert.rule} ${alert.subject}`);
    }

    it('stores an expected certificate once, from both sources, without an alert', async () => {
        crtsh.issuances = [issuance([ENGINE]), issuance([ENGINE])];
        certspotter.issuances = [issuance([ENGINE], { issuer: "C=US,O=Let's Encrypt,CN=R11" })];
        await runCtWatch(deps, signal);
        expect([...store.certs.values()]).toEqual([
            {
                issuanceSha256: await issuanceKey(issuance([ENGINE])),
                source: 'crt.sh',
                firstSeenAt: NOW,
                notBefore: NOW - DAY,
                hostnames: [ENGINE],
                issuer: LE,
                alert: [],
            },
        ]);
        expect(await alerts()).toEqual([]);
        expect(store.cursors).toEqual(
            new Map([
                ['crt.sh', '2'],
                ['certspotter', '1'],
            ]),
        );
        expect(test.logger.entries).toContainEqual({
            level: 'info',
            event: 'ct.run',
            fields: { sources: 2, certificates: 1, flagged: 0 },
        });
    });

    it('alerts once for a wildcard, a foreign issuer and an unknown hostname, each', async () => {
        const wildcard = issuance(['*.engines.ptbk.test']);
        const foreign = issuance([ENGINE], { issuer: 'C=US, O="DigiCert, Inc.", CN=DigiCert CA' });
        const unknown = issuance(['login.engines.ptbk.test', 'customer.example']);
        crtsh.issuances = [wildcard, foreign, unknown];
        certspotter.issuances = [wildcard, unknown];
        await runCtWatch(deps, signal);
        await runCtWatch(deps, signal);
        expect(await alerts()).toEqual([
            `ct-wildcard ${await issuanceKey(wildcard)}`,
            `ct-foreign-issuer ${await issuanceKey(foreign)}`,
            `ct-unknown-hostname ${await issuanceKey(unknown)}`,
        ]);
        expect(store.certs.get(await issuanceKey(foreign))?.alert).toEqual(['foreign-issuer']);
        expect((await monitor.alerts())[0]).toMatchObject({ state: 'firing', at: NOW, detail: { names: 1 } });
    });

    it('treats an issuer without an organization as foreign, and keys it by its whole name', async () => {
        const bare = issuance([ENGINE], { issuer: 'self-signed' });
        crtsh.issuances = [bare];
        await runCtWatch(deps, signal);
        expect(await alerts()).toEqual([`ct-foreign-issuer ${await issuanceKey(bare)}`]);
        expect(await issuanceKey(bare)).not.toBe(await issuanceKey(issuance([ENGINE], { issuer: 'other' })));
        const cnOnly = issuance([ENGINE], { issuer: 'CN=Some CA' });
        const orgOnly = issuance([ENGINE], { issuer: "O=Let's Encrypt" });
        crtsh.issuances.push(cnOnly, orgOnly);
        await runCtWatch(deps, signal);
        expect(await alerts()).toEqual([
            `ct-foreign-issuer ${await issuanceKey(bare)}`,
            `ct-foreign-issuer ${await issuanceKey(cnOnly)}`,
        ]);
    });

    it('degrades when one source fails or times out, and fails the run when both do', async () => {
        crtsh.fail = 'hang';
        certspotter.issuances = [issuance(['*.engines.ptbk.test'])];
        await runCtWatch(deps, signal);
        expect(await alerts()).toHaveLength(1);
        expect(test.logger.entries).toContainEqual({
            level: 'warn',
            event: 'ct.source-failed',
            fields: { source: 'crt.sh', problem: 'TimeoutError' },
        });
        expect(store.cursors.has('crt.sh')).toBe(false);

        certspotter.fail = new TypeError('fetch failed');
        await expect(runCtWatch(deps, signal)).rejects.toThrow('every CT source failed');
        crtsh.fail = 7 as unknown as Error;
        certspotter.fail = null;
        await runCtWatch(deps, signal);
        expect(test.logger.entries).toContainEqual({
            level: 'warn',
            event: 'ct.source-failed',
            fields: { source: 'crt.sh', problem: 'unknown' },
        });
    });

    it('raises one issuance alert when an engine’s certificates pass the limit within the window', async () => {
        const recent = (hours: number) => issuance([ENGINE], { notBefore: NOW - hours * 3_600_000 });
        crtsh.issuances = [recent(1), recent(2), recent(3), issuance([ENGINE], { notBefore: NOW - 30 * DAY })];
        await runCtWatch(deps, signal);
        expect(await alerts()).toEqual([]);
        crtsh.issuances.push(recent(4), recent(5));
        await runCtWatch(deps, signal);
        crtsh.issuances.push(recent(6));
        await runCtWatch(deps, signal);
        expect(await monitor.alerts()).toEqual([
            {
                rule: 'ct-issuance-spike',
                subject: 'k3v6xq2mfz4pd7h5wn2rbtcayu',
                state: 'firing',
                at: NOW,
                detail: { certificates: 5, days: 7 },
            },
        ]);
    });

    it('caps the alerts of one run and logs it', async () => {
        crtsh.issuances = Array.from({ length: MAX_CT_ALERTS_PER_RUN + 5 }, (_, index) =>
            issuance([`host-${String(index)}.engines.ptbk.test`]),
        );
        await runCtWatch(deps, signal);
        expect(await alerts()).toHaveLength(MAX_CT_ALERTS_PER_RUN);
        expect(test.logger.entries).toContainEqual({
            level: 'warn',
            event: 'ct.alerts-capped',
            fields: { alerts: MAX_CT_ALERTS_PER_RUN + 5, sent: MAX_CT_ALERTS_PER_RUN },
        });
        expect([...store.certs.values()].every((cert) => cert.alert.includes('unknown-hostname'))).toBe(true);
        expect(store.cursors.has('certspotter')).toBe(false);
    });

    it('forgets certificates past the retention', async () => {
        const old = { ...(await recordFor(issuance([ENGINE]))), firstSeenAt: NOW - CT_RETENTION_MS - 1 };
        store.certs.set(old.issuanceSha256, old);
        await runCtWatch(deps, signal);
        expect(store.certs.size).toBe(0);
    });

    it('runs without sources', async () => {
        await runCtWatch({ ...deps, sources: [] }, signal);
        expect(store.certs.size).toBe(0);
    });
});

async function recordFor(item: CtIssuance) {
    return {
        issuanceSha256: await issuanceKey(item),
        source: 'crt.sh' as const,
        firstSeenAt: NOW,
        notBefore: item.notBefore,
        hostnames: item.hostnames,
        issuer: item.issuer,
        alert: [],
    };
}
