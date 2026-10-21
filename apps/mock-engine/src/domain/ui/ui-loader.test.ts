import { EngineVersion } from '@ptbk/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { createMemoryBundleStore } from '../../testing/memory-bundle-store';
import { createMemoryLogger } from '../../testing/memory-logger';
import { createMemoryReleaseSource } from '../../testing/memory-release-source';
import { createMemoryUpdateStateStore } from '../../testing/memory-update-state-store';
import type { TestReleaseKeys } from '../../testing/ui-releases';
import {
    TEST_ARCHIVE_NAME,
    buildTestBundle,
    createTestProvenanceVerifier,
    createTestReleaseKeys,
    signTestRelease,
    signTestRevocations,
} from '../../testing/ui-releases';
import type { InstalledBundle } from './bundle-store';
import { createUiLoader } from './ui-loader';
import type { UpdatePolicy } from './update-policy';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-21T12:00:00Z');

let keys: TestReleaseKeys;
beforeAll(async () => {
    keys = await createTestReleaseKeys();
});

async function setup(updatePolicy: UpdatePolicy) {
    const clock = createFakeClock(NOW);
    const source = createMemoryReleaseSource();
    source.setRevocations(
        await signTestRevocations(keys, { issuedAt: new Date(NOW - HOUR), expiresAt: new Date(NOW + 24 * HOUR) }),
    );
    for (const text of ['1.0.0', '1.1.0']) {
        const bundle = buildTestBundle({ version: text });
        const record = await signTestRelease(keys, {
            version: text,
            archiveSha256: bundle.sha256,
            publishedAt: new Date(NOW - 100 * HOUR),
        });
        source.publish(EngineVersion.parse(text), {
            record,
            artifacts: new Map([[TEST_ARCHIVE_NAME, bundle.archive]]),
        });
    }
    const store = createMemoryBundleStore();
    const seen: InstalledBundle[] = [];
    const deps = {
        source,
        store,
        state: createMemoryUpdateStateStore(),
        provenance: createTestProvenanceVerifier(),
        trust: keys.policy,
    };
    const loader = () =>
        createUiLoader({
            updatePolicy,
            checkIntervalS: 60,
            deps,
            clock,
            logger: createMemoryLogger(),
            onActive: (bundle) => seen.push(bundle),
        });
    return { clock, store, seen, loader };
}

describe('createUiLoader', () => {
    it('reports the active bundle at start and after every install', async () => {
        const world = await setup({ kind: 'pinned', version: EngineVersion.parse('1.0.0') });
        const loader = world.loader();
        expect(await loader.checkNow()).toMatchObject({ kind: 'installed', version: '1.0.0' });
        expect(world.seen.map((bundle) => bundle.version)).toEqual(['1.0.0']);
        expect(await loader.checkNow()).toMatchObject({ kind: 'up-to-date' });
        expect(world.seen).toHaveLength(1);
        world.loader();
        expect(world.seen.map((bundle) => bundle.version)).toEqual(['1.0.0', '1.0.0']);
    });

    it('re-pins only under pinned', async () => {
        const pinned = (await setup({ kind: 'pinned', version: EngineVersion.parse('1.0.0') })).loader();
        expect(pinned.pin(EngineVersion.parse('1.1.0'))).toBe(true);
        expect(pinned.policy()).toEqual({ kind: 'pinned', version: '1.1.0' });
        expect(await pinned.checkNow()).toMatchObject({ kind: 'installed', version: '1.1.0' });
        expect(pinned.lastOutcome()).toMatchObject({ version: '1.1.0' });
        const manual = (await setup({ kind: 'manual' })).loader();
        expect(manual.pin(EngineVersion.parse('1.1.0'))).toBe(false);
        expect(manual.policy()).toEqual({ kind: 'manual' });
    });

    it('checks on its own under auto and pinned, and only when asked under manual', async () => {
        const manual = await setup({ kind: 'manual' });
        const idle = manual.loader();
        idle.start();
        manual.clock.advance(10 * 60_000);
        await new Promise((resolve) => setImmediate(resolve));
        expect(manual.store.active()).toBeUndefined();
        await idle.stop();

        const pinned = await setup({ kind: 'pinned', version: EngineVersion.parse('1.0.0') });
        const busy = pinned.loader();
        busy.start();
        await new Promise((resolve) => setImmediate(resolve));
        await busy.checkNow();
        expect(pinned.store.active()?.version).toBe('1.0.0');
        await busy.stop();
    });
});
