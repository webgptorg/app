import { Hostname } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    createFakePublicFaceFetcher,
    mockEngineFace,
    type FakePublicFaceFetcher,
} from '../../testing/fake-public-face-fetcher';
import { createMemoryPublicFaceStore, type MemoryPublicFaceStore } from '../../testing/memory-public-face-store';
import { createMemoryMonitor, createMonitoringTestDeps, type MonitoringTestDeps } from '../../testing/test-monitoring';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { orgIdSchema } from '../ids';
import type { EngineRecord } from '../registration/engine-store';
import { MOCK_ENGINE_SIGN_IN_FINGERPRINT } from './public-face';
import { PUBLIC_FACE_RETENTION_MS, runPublicFaceCheck, type PublicFaceJobDeps } from './public-face-job';

const NOW = Date.UTC(2026, 9, 23, 12);
const ORG = orgIdSchema.parse('a'.repeat(26));
const signal = new AbortController().signal;

describe('runPublicFaceCheck', () => {
    let test: MonitoringTestDeps;
    let engines: Map<string, EngineRecord>;
    let store: MemoryPublicFaceStore;
    let fetcher: FakePublicFaceFetcher;
    let monitor: ReturnType<typeof createMemoryMonitor>;
    let deps: PublicFaceJobDeps;

    async function engine(status: 'active' | 'suspended' = 'active'): Promise<EngineRecord> {
        const row = engineRecord(await createTestEngine(), ORG, { status });
        engines.set(row.engineId, row);
        return row;
    }

    beforeEach(() => {
        test = createMonitoringTestDeps(NOW);
        engines = new Map();
        store = createMemoryPublicFaceStore({ engines: () => engines.values() });
        fetcher = createFakePublicFaceFetcher();
        monitor = createMemoryMonitor();
        deps = {
            engineDomain: Hostname.parse('engines.ptbk.test'),
            fetcher,
            store,
            monitor,
            settings: {
                fingerprints: new Set([MOCK_ENGINE_SIGN_IN_FINGERPRINT]),
                perRun: 10,
                concurrency: 2,
                timeoutMs: 50,
            },
            clock: test.clock,
            logger: test.logger,
        };
    });

    it('records match, mismatch and unreachable, and alerts the abuse inbox for the mismatch only', async () => {
        const good = await engine();
        const odd = await engine();
        const offline = await engine();
        await engine('suspended');
        for (const [url, answer] of mockEngineFace(good.hostname)) fetcher.routes.set(url, answer);
        fetcher.routes.set(`https://${odd.hostname}/`, { status: 302, location: 'https://phish.example/' });
        fetcher.routes.set(`https://${offline.hostname}/`, 'hang');

        await runPublicFaceCheck(deps, signal);

        expect(new Map(store.checks.map((check) => [check.engineId, check.result]))).toEqual(
            new Map([
                [good.engineId, 'match'],
                [odd.engineId, 'mismatch'],
                [offline.engineId, 'unreachable'],
            ]),
        );
        expect(store.checks.every((check) => check.checkedAt === NOW)).toBe(true);
        expect(await monitor.alerts()).toEqual([
            { rule: 'public-face-mismatch', subject: odd.engineId, state: 'firing', at: NOW, detail: {} },
        ]);
        expect(fetcher.requested.every((url) => url.includes('.engines.ptbk.test/'))).toBe(true);
        expect(engines.get(odd.engineId)?.status).toBe('active');
        expect(test.logger.entries).toContainEqual({
            level: 'info',
            event: 'public-face.run',
            fields: { checked: 3, mismatch: 1, unreachable: 1 },
        });
    });

    it('alerts once while the page stays wrong, keeps quiet while unreachable, and resolves on a match', async () => {
        const odd = await engine();
        fetcher.routes.set(`https://${odd.hostname}/`, { status: 200, body: '<title>Bank</title>' });
        await runPublicFaceCheck(deps, signal);
        test.clock.advance(1000);
        await runPublicFaceCheck(deps, signal);
        fetcher.routes.delete(`https://${odd.hostname}/`);
        test.clock.advance(1000);
        await runPublicFaceCheck(deps, signal);
        for (const [url, answer] of mockEngineFace(odd.hostname)) fetcher.routes.set(url, answer);
        test.clock.advance(1000);
        await runPublicFaceCheck(deps, signal);
        expect((await monitor.alerts()).map((alert) => alert.state)).toEqual(['firing', 'resolved']);
    });

    it('visits the longest unchecked engines first, perRun at a time, and says when it falls behind', async () => {
        const all = await Promise.all([engine(), engine(), engine()]);
        await runPublicFaceCheck({ ...deps, settings: { ...deps.settings, perRun: 2 } }, signal);
        expect(store.checks).toHaveLength(2);
        expect(test.logger.entries).toContainEqual({
            level: 'warn',
            event: 'public-face.behind',
            fields: { engines: 1 },
        });
        test.clock.advance(1000);
        await runPublicFaceCheck({ ...deps, settings: { ...deps.settings, perRun: 2 } }, signal);
        expect(new Set(store.checks.map((check) => check.engineId))).toEqual(new Set(all.map((row) => row.engineId)));
    });

    it('never visits a hostname outside the engine domain, and forgets checks past the retention', async () => {
        const stray = await engine();
        engines.set(stray.engineId, { ...stray, hostname: Hostname.parse('elsewhere.example') });
        store.checks.push({
            engineId: stray.engineId,
            checkedAt: NOW - PUBLIC_FACE_RETENTION_MS - 1,
            result: 'match',
            fingerprint: MOCK_ENGINE_SIGN_IN_FINGERPRINT,
        });
        await runPublicFaceCheck(deps, signal);
        expect(fetcher.requested).toEqual([]);
        expect(store.checks).toEqual([]);
    });
});
