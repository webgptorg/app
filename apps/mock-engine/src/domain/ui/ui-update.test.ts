import type { DsseEnvelope, EngineVersion } from '@ptbk/protocol';
import { EngineVersion as EngineVersionSchema, RELEASE_DELAYS, encodeBase64Std, decodeBase64Std } from '@ptbk/protocol';
import { beforeAll, describe, expect, it } from 'vitest';

import type { FakeClock } from '../../testing/fake-clock';
import { createFakeClock } from '../../testing/fake-clock';
import type { MemoryLogger } from '../../testing/memory-logger';
import { createMemoryLogger } from '../../testing/memory-logger';
import { createMemoryBundleStore } from '../../testing/memory-bundle-store';
import type { MemoryReleaseSource } from '../../testing/memory-release-source';
import { createMemoryReleaseSource } from '../../testing/memory-release-source';
import type { UpdateStateSnapshot } from '../../testing/memory-update-state-store';
import { createMemoryUpdateStateStore } from '../../testing/memory-update-state-store';
import type { TestBundle, TestBundleInput, TestReleaseInput, TestReleaseKeys } from '../../testing/ui-releases';
import {
    TEST_ARCHIVE_NAME,
    TEST_BUNDLE_FILES,
    TEST_WORKFLOW_IDENTITY,
    buildTestBundle,
    createTestProvenanceVerifier,
    createTestReleaseKeys,
    signTestRelease,
    signTestRevocations,
} from '../../testing/ui-releases';
import type { BundleStore } from './bundle-store';
import type { UiUpdateOutcome } from './ui-update';
import { checkForUiUpdate, uiUpdateCheckOf } from './ui-update';
import type { UpdatePolicy } from './update-policy';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-21T12:00:00Z');
const version = (text: string): EngineVersion => EngineVersionSchema.parse(text);

let keys: TestReleaseKeys;
beforeAll(async () => {
    keys = await createTestReleaseKeys();
});

interface World {
    readonly clock: FakeClock;
    readonly source: MemoryReleaseSource;
    readonly store: BundleStore & { stagedCount(): number };
    state: ReturnType<typeof createMemoryUpdateStateStore>;
    readonly logger: MemoryLogger;
    policy: UpdatePolicy;
}

function world(policy: UpdatePolicy = { kind: 'manual' }): World {
    return {
        clock: createFakeClock(NOW),
        source: createMemoryReleaseSource(),
        store: createMemoryBundleStore(),
        state: createMemoryUpdateStateStore(),
        logger: createMemoryLogger(),
        policy,
    };
}

function check(w: World): Promise<UiUpdateOutcome> {
    return checkForUiUpdate({
        source: w.source,
        store: w.store,
        state: w.state,
        provenance: createTestProvenanceVerifier(),
        trust: keys.policy,
        policy: w.policy,
        engineApiVersion: '1.1.0',
        clock: w.clock,
        logger: w.logger,
        signal: new AbortController().signal,
    });
}

interface PublishOptions {
    readonly bundle?: Partial<TestBundleInput>;
    readonly release?: Partial<TestReleaseInput>;
    /** What the store serves instead of the signed archive. */
    readonly serve?: (archive: Uint8Array<ArrayBuffer>) => Uint8Array;
    /** Changes the signed record after signing. */
    readonly edit?: (record: { envelope: DsseEnvelope; provenance: string }) => void;
    readonly latest?: boolean;
}

async function publish(w: World, text: string, options: PublishOptions = {}): Promise<TestBundle> {
    const bundle = buildTestBundle({ version: text, ...options.bundle });
    const record = (await signTestRelease(keys, {
        version: text,
        archiveSha256: bundle.sha256,
        publishedAt: new Date(NOW - 100 * HOUR),
        ...options.release,
    })) as { envelope: DsseEnvelope; provenance: string };
    options.edit?.(record);
    const served = options.serve?.(bundle.archive) ?? bundle.archive;
    w.source.publish(
        version(text),
        { record, artifacts: new Map([[TEST_ARCHIVE_NAME, served]]) },
        options.latest === undefined ? {} : { latest: options.latest },
    );
    return bundle;
}

async function freshRevocations(
    w: World,
    issuedAt = w.clock.nowMs() - HOUR,
    revoked: { version: string; reason: string }[] = [],
) {
    w.source.setRevocations(
        await signTestRevocations(keys, {
            issuedAt: new Date(issuedAt),
            expiresAt: new Date(issuedAt + 7 * 24 * HOUR),
            revoked,
        }),
    );
}

/** A world with 1.0.0 installed and a fresh revocation list. */
async function installed(policy?: UpdatePolicy): Promise<World> {
    const w = world(policy);
    await freshRevocations(w);
    await publish(w, '1.0.0');
    expect(await check(w)).toMatchObject({ kind: 'installed', version: '1.0.0' });
    return w;
}

function expectStillActive(w: World, text = '1.0.0'): void {
    expect(w.store.active()?.version).toBe(text);
    expect(w.store.stagedCount()).toBe(0);
}

function flip(archive: Uint8Array<ArrayBuffer>): Uint8Array {
    const copy = archive.slice();
    copy[copy.length - 5] = (copy[copy.length - 5] ?? 0) ^ 1;
    return copy;
}

describe('checkForUiUpdate: install', () => {
    it('installs a release with both the release-key signature and the workflow provenance', async () => {
        const w = world();
        await freshRevocations(w);
        const bundle = await publish(w, '1.0.0');
        expect(await check(w)).toEqual({ kind: 'installed', version: '1.0.0', sha256: bundle.sha256 });
        const active = w.store.active();
        expect(active).toMatchObject({ version: '1.0.0', sha256: bundle.sha256, logIndex: 4242 });
        expect(active?.manifest).toEqual(bundle.manifest);
        expect(await w.store.read(active ?? never(), 'index.html')).toBeDefined();
        expect(w.logger.entries).toContainEqual({
            level: 'info',
            event: 'ui.installed',
            fields: { version: '1.0.0', sha256: bundle.sha256, logIndex: 4242 },
        });
        expect(w.state.snapshot().lastAcceptedRevocationIssuedAt).toEqual(new Date(NOW - HOUR));
        expect(w.state.snapshot().firstSeen.size).toBe(1);
    });

    it('keeps the previous bundle when a newer one installs, and reports the active one as up to date', async () => {
        const w = await installed();
        await publish(w, '1.1.0');
        expect(await check(w)).toMatchObject({ kind: 'installed', version: '1.1.0' });
        expect(w.store.previous()?.version).toBe('1.0.0');
        expect(await check(w)).toEqual({ kind: 'up-to-date', version: '1.1.0' });
    });

    it('installs a bundle whose manifest records another CSP: the loader never reads it', async () => {
        const w = world();
        await freshRevocations(w);
        await publish(w, '1.0.0', { bundle: { csp: "default-src *; script-src 'unsafe-inline' 'unsafe-eval'" } });
        expect(await check(w)).toMatchObject({ kind: 'installed' });
        expect(w.store.active()?.manifest.csp).toContain('unsafe-eval');
    });

    it('finds the ui artifact by kind, whatever its name', async () => {
        const w = world();
        await freshRevocations(w);
        const bundle = buildTestBundle({ version: '1.0.0' });
        const record = await signTestRelease(keys, {
            version: '1.0.0',
            archiveSha256: bundle.sha256,
            publishedAt: new Date(NOW - 100 * HOUR),
            artifacts: [
                { name: 'engine-linux-x64', sha256: 'a'.repeat(64), kind: 'engine' },
                { name: 'web.tar.zst', sha256: bundle.sha256, kind: 'ui' },
            ],
        });
        w.source.publish(version('1.0.0'), { record, artifacts: new Map([['web.tar.zst', bundle.archive]]) });
        expect(await check(w)).toMatchObject({ kind: 'installed' });
    });
});

describe('checkForUiUpdate: refusals keep the previous bundle', () => {
    async function expectRefused(
        options: PublishOptions,
        reason: string,
        prepare?: (w: World) => Promise<void>,
    ): Promise<World> {
        const w = await installed();
        await prepare?.(w);
        await publish(w, '1.1.0', options);
        expect(await check(w)).toEqual({ kind: 'refused', version: '1.1.0', reason });
        expectStillActive(w);
        expect(w.logger.entries).toContainEqual({
            level: 'warn',
            event: 'ui.refused',
            fields: { version: '1.1.0', reason },
        });
        expect(w.logger.text()).not.toContain('document.body');
        return w;
    }

    it('refuses a release signed with the release key but without provenance', async () => {
        await expectRefused({ release: { provenance: null } }, 'signature-threshold-not-met');
    });

    it('refuses a release with provenance but without the release-key signature', async () => {
        await expectRefused({ release: { signers: [keys.maintainers[0]] } }, 'signature-threshold-not-met');
        await expectRefused({ release: { signers: [keys.outsider] } }, 'signature-threshold-not-met');
    });

    it('refuses provenance from another workflow identity', async () => {
        await expectRefused(
            { release: { provenance: { identity: { ...TEST_WORKFLOW_IDENTITY, repository: 'webgptorg/fork' } } } },
            'signature-threshold-not-met',
        );
    });

    it('refuses an envelope whose payload changed after signing', async () => {
        await expectRefused(
            {
                edit: (record) => {
                    const payload = decodeBase64Std(record.envelope.payload);
                    if (payload.kind !== 'ok') throw new Error('bad payload');
                    const changed = new TextEncoder().encode(
                        new TextDecoder().decode(payload.bytes).replace('"regular"', '"security"'),
                    );
                    record.envelope = { ...record.envelope, payload: encodeBase64Std(changed) };
                },
            },
            'signature-threshold-not-met',
        );
    });

    it('refuses an envelope whose payload type changed after signing', async () => {
        await expectRefused(
            { edit: (record) => (record.envelope = { ...record.envelope, payloadType: 'application/json' }) },
            'invalid-entry',
        );
    });

    it('refuses a record that is not a signed release, and a release without a ui artifact', async () => {
        await expectRefused({ edit: (record) => (record.provenance = 7 as unknown as string) }, 'invalid-entry');
        await expectRefused(
            { release: { artifacts: [{ name: 'engine-linux-x64', sha256: 'b'.repeat(64), kind: 'engine' }] } },
            'invalid-entry',
        );
    });

    it('refuses provenance without a log entry, or without any trusted time, as not in the log', async () => {
        await expectRefused({ release: { provenance: { logIndex: null } } }, 'not-in-log');
        await expectRefused({ release: { provenance: { timestamps: [] } } }, 'not-in-log');
    });

    it('refuses a revoked version', async () => {
        await expectRefused({}, 'revoked', (w) => freshRevocations(w, NOW, [{ version: '1.1.0', reason: 'leaks' }]));
    });

    it('refuses an older or equal version than the active one', async () => {
        const w = await installed();
        await publish(w, '0.9.0');
        expect(await check(w)).toEqual({ kind: 'refused', version: '0.9.0', reason: 'not-newer' });
        expectStillActive(w);
    });

    it('refuses the active version with a different artifact as not newer, not as up to date', async () => {
        const w = await installed();
        await publish(w, '1.0.0', { bundle: { files: [{ path: 'index.html', bytes: new Uint8Array(3) }] } });
        expect(await check(w)).toMatchObject({ kind: 'refused', reason: 'not-newer' });
    });

    it('refuses an artifact whose SHA-256 differs from the signed entry', async () => {
        await expectRefused({ serve: flip }, 'hash-mismatch');
    });

    it('refuses an archive that does not unpack', async () => {
        const garbage = new TextEncoder().encode('not a tar.zst');
        const w = await installed();
        const record = await signTestRelease(keys, {
            version: '1.1.0',
            archiveSha256: await sha256Hex(garbage),
            publishedAt: new Date(NOW - 100 * HOUR),
        });
        w.source.publish(version('1.1.0'), { record, artifacts: new Map([[TEST_ARCHIVE_NAME, garbage]]) });
        expect(await check(w)).toMatchObject({ kind: 'refused', reason: 'unpack' });
        expectStillActive(w);
    });

    it.each<[string, Partial<TestBundleInput>]>([
        [
            'a file hash',
            {
                editManifest: (manifest) => ({
                    ...manifest,
                    files: manifest.files.map((file) => ({ ...file, sha256: '0'.repeat(64) })),
                }),
            },
        ],
        [
            'a file size',
            {
                editManifest: (manifest) => ({
                    ...manifest,
                    files: manifest.files.map((file) => ({ ...file, size: file.size + 1 })),
                }),
            },
        ],
        ['a file the manifest does not list', { unlisted: [{ path: 'extra.js', bytes: new Uint8Array(1) }] }],
        ['a manifest version other than the entry’s', { version: '1.0.5' }],
        ['a manifest commit other than the entry’s', { commit: 'd'.repeat(40) }],
        [
            'a file on an engine-owned path',
            { files: [...TEST_BUNDLE_FILES, { path: 'auth/sign-in', bytes: new Uint8Array(1) }] },
        ],
        [
            'a file under the API prefix',
            { files: [...TEST_BUNDLE_FILES, { path: 'api/v1/me', bytes: new Uint8Array(1) }] },
        ],
        [
            'a file under /__mock/',
            { files: [...TEST_BUNDLE_FILES, { path: '__mock/state', bytes: new Uint8Array(1) }] },
        ],
        ['a manifest that is not a UiBundleManifest', { editManifest: (manifest) => ({ ...manifest, extra: true }) }],
    ])('refuses a bundle with %s as a manifest mismatch', async (_, bundle) => {
        await expectRefused({ bundle }, 'manifest');
    });

    it('refuses a bundle whose engineApi range excludes ENGINE_API_VERSION', async () => {
        await expectRefused({ bundle: { engineApi: '>=2.0.0 <3.0.0' } }, 'engine-api');
    });
});

describe('checkForUiUpdate: unavailable', () => {
    it.each(['latest', 'release', 'revocations', 'artifact', 'artifact-mid-stream'] as const)(
        'answers unavailable when %s fails, and keeps the active bundle',
        async (step) => {
            const w = await installed();
            await publish(w, '1.1.0');
            w.source.fail(step);
            expect(await check(w)).toEqual({ kind: 'unavailable' });
            expectStillActive(w);
            expect(w.logger.entries).toContainEqual({
                level: 'warn',
                event: 'ui.unavailable',
                fields: { step: step === 'artifact-mid-stream' ? 'artifact' : step },
            });
        },
    );

    it('answers unavailable for an artifact over the size cap', async () => {
        const w = await installed();
        const huge = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new Uint8Array(64 * 1024 * 1024));
            },
        });
        await publish(w, '1.1.0');
        const artifact = w.source.artifact.bind(w.source);
        w.source.artifact = (v, name, signal) => (v === '1.1.0' ? Promise.resolve(huge) : artifact(v, name, signal));
        expect(await check(w)).toEqual({ kind: 'unavailable' });
        expectStillActive(w);
    });
});

describe('checkForUiUpdate: update delay under auto', () => {
    const delay = RELEASE_DELAYS.regularMs;

    it('waits the full delay from first sight, even with an old publishedAt and trusted time', async () => {
        const w = world({ kind: 'auto' });
        await freshRevocations(w, NOW - HOUR);
        const old = new Date(NOW - 30 * 24 * HOUR);
        await publish(w, '1.0.0', { release: { publishedAt: old, provenance: { timestamps: [old] } } });
        const eligibleAt = new Date(NOW + delay);
        expect(await check(w)).toEqual({ kind: 'refused', version: '1.0.0', reason: 'delay-not-elapsed', eligibleAt });
        w.clock.advance(delay - 1);
        expect(await check(w)).toMatchObject({ kind: 'refused', reason: 'delay-not-elapsed', eligibleAt });
        w.clock.advance(1);
        expect(await check(w)).toMatchObject({ kind: 'installed', version: '1.0.0' });
    });

    it('counts from the latest trusted timestamp when it is later than first sight', async () => {
        const w = world({ kind: 'auto' });
        await freshRevocations(w, NOW - HOUR);
        const timestamps = [new Date(NOW - 2 * HOUR), new Date(NOW + 2 * HOUR)];
        await publish(w, '1.0.0', {
            release: { publishedAt: new Date(NOW - 1000 * HOUR), provenance: { timestamps } },
        });
        const eligibleAt = new Date(NOW + 2 * HOUR + delay);
        expect(await check(w)).toMatchObject({ kind: 'refused', reason: 'delay-not-elapsed', eligibleAt });
        w.clock.advance(delay);
        expect(await check(w)).toMatchObject({ kind: 'refused', reason: 'delay-not-elapsed', eligibleAt });
        w.clock.advance(2 * HOUR);
        expect(await check(w)).toMatchObject({ kind: 'installed' });
    });

    it('keeps the first-seen time across a restart, so the delay neither restarts nor shortens', async () => {
        const w = world({ kind: 'auto' });
        await freshRevocations(w, NOW - HOUR);
        await publish(w, '1.0.0', { release: { publishedAt: new Date(NOW - 1000 * HOUR) } });
        expect(await check(w)).toMatchObject({ reason: 'delay-not-elapsed', eligibleAt: new Date(NOW + delay) });
        w.clock.advance(HOUR);
        // A restart: a new store that loads what the old one persisted.
        w.state = createMemoryUpdateStateStore(w.state.snapshot());
        expect(await check(w)).toMatchObject({ reason: 'delay-not-elapsed', eligibleAt: new Date(NOW + delay) });
        w.clock.advance(delay - HOUR);
        await freshRevocations(w, w.clock.nowMs() - HOUR);
        expect(await check(w)).toMatchObject({ kind: 'installed' });
    });

    it('lets manual approval and a pinned version install before the delay, and nothing else', async () => {
        for (const policy of [{ kind: 'manual' }, { kind: 'pinned', version: version('1.0.0') }] as const) {
            const w = world(policy);
            await freshRevocations(w);
            await publish(w, '1.0.0', { release: { publishedAt: new Date(NOW) } });
            expect(await check(w)).toMatchObject({ kind: 'installed' });
            await publish(w, '1.1.0', { release: { provenance: null } });
            w.policy = policy.kind === 'pinned' ? { kind: 'pinned', version: version('1.1.0') } : policy;
            expect(await check(w)).toMatchObject({ kind: 'refused', reason: 'signature-threshold-not-met' });
        }
    });

    it('fetches only the pinned version under pinned, whatever is latest', async () => {
        const w = world({ kind: 'pinned', version: version('1.0.0') });
        await freshRevocations(w);
        await publish(w, '1.0.0', { latest: false });
        await publish(w, '2.0.0');
        expect(await check(w)).toMatchObject({ kind: 'installed', version: '1.0.0' });
        expect(await check(w)).toEqual({ kind: 'up-to-date', version: '1.0.0' });
    });
});

describe('checkForUiUpdate: revocation list', () => {
    async function expectUnverifiable(w: World, revocationReason: string): Promise<void> {
        await publish(w, '1.1.0');
        expect(await check(w)).toEqual({
            kind: 'refused',
            version: '1.1.0',
            reason: 'revocations-unverifiable',
            revocationReason,
        });
        expectStillActive(w);
        expect(w.logger.entries).toContainEqual({
            level: 'error',
            event: 'ui.revocations-unverifiable',
            fields: { version: '1.1.0', reason: revocationReason },
        });
    }

    it('refuses with reason missing, and alerts, when there is no list', async () => {
        const w = await installed();
        w.source.setRevocations(null);
        await expectUnverifiable(w, 'missing');
    });

    it('refuses with reason expired once the list has expired', async () => {
        const w = await installed();
        w.clock.advance(7 * 24 * HOUR);
        await expectUnverifiable(w, 'expired');
    });

    it('refuses with reason invalid when the list is signed by an untrusted key or is not an envelope', async () => {
        const w = await installed();
        w.source.setRevocations(
            await signTestRevocations(keys, {
                issuedAt: new Date(NOW),
                expiresAt: new Date(NOW + 24 * HOUR),
                signer: keys.outsider,
            }),
        );
        await expectUnverifiable(w, 'invalid');
        w.source.setRevocations({ not: 'an envelope' });
        await expectUnverifiable(w, 'invalid');
    });

    it('refuses with reason rolled-back for a list older than one accepted before, also after a restart', async () => {
        const w = await installed();
        await freshRevocations(w, NOW - 0.5 * HOUR);
        await publish(w, '1.1.0');
        expect(await check(w)).toMatchObject({ kind: 'installed' });
        expect(w.state.snapshot().lastAcceptedRevocationIssuedAt).toEqual(new Date(NOW - 0.5 * HOUR));

        await freshRevocations(w, NOW - HOUR);
        await publish(w, '1.2.0');
        const persisted: UpdateStateSnapshot = w.state.snapshot();
        w.state = createMemoryUpdateStateStore(persisted);
        expect(await check(w)).toMatchObject({
            kind: 'refused',
            reason: 'revocations-unverifiable',
            revocationReason: 'rolled-back',
        });
        expect(w.store.active()?.version).toBe('1.1.0');
    });

    it('never moves the accepted issuedAt backwards', async () => {
        const state = createMemoryUpdateStateStore();
        await state.acceptRevocations(new Date(NOW));
        await state.acceptRevocations(new Date(NOW - HOUR));
        expect(await state.lastAcceptedRevocationIssuedAt()).toEqual(new Date(NOW));
    });
});

describe('checkForUiUpdate: a revoked active bundle', () => {
    const revoke = (w: World, ...versions: string[]) =>
        freshRevocations(
            w,
            w.clock.nowMs(),
            versions.map((text) => ({ version: text, reason: 'compromised' })),
        );

    /** 1.0.0 then 1.1.0 installed, so 1.1.0 is active and 1.0.0 previous. */
    async function twoInstalled(): Promise<World> {
        const w = await installed();
        await publish(w, '1.1.0');
        expect(await check(w)).toMatchObject({ kind: 'installed', version: '1.1.0' });
        w.clock.advance(1000);
        return w;
    }

    it('stops serving it at once and brings the previous bundle back', async () => {
        const w = await twoInstalled();
        await revoke(w, '1.1.0');
        expect(await check(w)).toEqual({ kind: 'refused', version: '1.1.0', reason: 'revoked' });
        expect(w.store.active()?.version).toBe('1.0.0');
        expect(w.store.previous()).toBeUndefined();
        expect(w.logger.entries).toContainEqual({
            level: 'error',
            event: 'ui.revoked-active',
            fields: { version: '1.1.0', restored: '1.0.0' },
        });
        expect(await check(w)).toEqual({ kind: 'refused', version: '1.1.0', reason: 'revoked' });
        expect(w.store.active()?.version).toBe('1.0.0');
    });

    it('leaves no bundle active when the previous one is revoked too', async () => {
        const w = await twoInstalled();
        await revoke(w, '1.0.0', '1.1.0');
        expect(await check(w)).toEqual({ kind: 'refused', version: '1.1.0', reason: 'revoked' });
        expect(w.store.active()).toBeUndefined();
        expect(w.store.previous()).toBeUndefined();
        expect(w.logger.entries).toContainEqual({
            level: 'error',
            event: 'ui.revoked-active',
            fields: { version: '1.1.0' },
        });
    });

    it('reports the revoked bundle, not the candidate, when the candidate is the previous one', async () => {
        const w = await twoInstalled();
        await revoke(w, '1.1.0');
        w.policy = { kind: 'pinned', version: version('1.0.0') };
        expect(await check(w)).toEqual({ kind: 'refused', version: '1.1.0', reason: 'revoked' });
        expect(w.store.active()?.version).toBe('1.0.0');
    });

    it('reports the install when the same check installs a newer release', async () => {
        const w = await twoInstalled();
        await revoke(w, '1.1.0');
        await publish(w, '1.2.0');
        expect(await check(w)).toMatchObject({ kind: 'installed', version: '1.2.0' });
        expect(w.store.active()?.version).toBe('1.2.0');
        expect(w.store.previous()?.version).toBe('1.0.0');
    });

    it('judges the candidate against the bundle it fell back to', async () => {
        const w = await installed({ kind: 'pinned', version: version('1.0.0') });
        await publish(w, '1.2.0');
        w.policy = { kind: 'pinned', version: version('1.2.0') };
        expect(await check(w)).toMatchObject({ kind: 'installed', version: '1.2.0' });
        await publish(w, '1.1.0', { latest: false });
        await revoke(w, '1.2.0');
        w.policy = { kind: 'pinned', version: version('1.1.0') };
        expect(await check(w)).toMatchObject({ kind: 'installed', version: '1.1.0' });
        expect(w.store.previous()?.version).toBe('1.0.0');
    });

    it('still reports the revoked bundle when the candidate is refused for another reason', async () => {
        const w = await twoInstalled();
        await revoke(w, '1.1.0');
        await publish(w, '1.2.0', { serve: flip });
        expect(await check(w)).toEqual({ kind: 'refused', version: '1.1.0', reason: 'revoked' });
        expect(w.store.active()?.version).toBe('1.0.0');
        expect(w.logger.entries).toContainEqual({
            level: 'warn',
            event: 'ui.refused',
            fields: { version: '1.2.0', reason: 'hash-mismatch' },
        });
    });

    it('drops a revoked previous bundle and keeps serving the active one', async () => {
        const w = await twoInstalled();
        await revoke(w, '1.0.0');
        expect(await check(w)).toEqual({ kind: 'up-to-date', version: '1.1.0' });
        expect(w.store.active()?.version).toBe('1.1.0');
        expect(w.store.previous()).toBeUndefined();
        expect(w.logger.entries).toContainEqual({
            level: 'warn',
            event: 'ui.revoked-previous',
            fields: { version: '1.0.0' },
        });
    });

    it('matches revoked versions by SemVer precedence, ignoring build metadata', async () => {
        const w = await twoInstalled();
        await revoke(w, '1.1.0+rebuilt');
        expect(await check(w)).toEqual({ kind: 'refused', version: '1.1.0', reason: 'revoked' });
        expect(w.store.active()?.version).toBe('1.0.0');
    });

    it('never acts on a list it could not accept: expired, untrusted, rolled back, or never checked', async () => {
        const w = await twoInstalled();
        const signed = (issuedAt: number, validMs: number, signer = keys.release) =>
            signTestRevocations(keys, {
                issuedAt: new Date(issuedAt),
                expiresAt: new Date(issuedAt + validMs),
                revoked: [{ version: '1.1.0', reason: 'compromised' }],
                signer,
            });
        const unverifiable = async (revocationReason: string) => {
            expect(await check(w)).toMatchObject({ reason: 'revocations-unverifiable', revocationReason });
        };
        w.source.setRevocations(await signed(w.clock.nowMs() - 2 * HOUR, HOUR));
        await unverifiable('expired');
        w.source.setRevocations(await signed(w.clock.nowMs(), HOUR, keys.outsider));
        await unverifiable('invalid');
        w.source.setRevocations(await signed(NOW - 2 * HOUR, 24 * HOUR));
        await unverifiable('rolled-back');
        await publish(w, '1.2.0', { release: { provenance: null } });
        await revoke(w, '1.1.0');
        expect(await check(w)).toMatchObject({ reason: 'signature-threshold-not-met' });
        expect(w.store.active()?.version).toBe('1.1.0');
        expect(w.store.previous()?.version).toBe('1.0.0');
        expect(w.logger.entries.map(({ event }) => event)).not.toContain('ui.revoked-active');
    });
});

function never(): never {
    throw new Error('unreachable');
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('uiUpdateCheckOf', () => {
    const at = Date.parse('2026-10-20T10:00:00.250Z');
    const version = EngineVersionSchema.parse('1.2.0');

    it('reports each outcome for the security panel, with the reason only for a refusal', () => {
        expect(uiUpdateCheckOf({ kind: 'installed', version, sha256: 'a'.repeat(64) }, at)).toEqual({
            at: '2026-10-20T10:00:00Z',
            outcome: 'installed',
            version: '1.2.0',
            reason: null,
            revocationReason: null,
            eligibleAt: null,
        });
        expect(uiUpdateCheckOf({ kind: 'up-to-date', version }, at)).toMatchObject({
            outcome: 'up-to-date',
            reason: null,
        });
        expect(uiUpdateCheckOf({ kind: 'unavailable' }, at)).toMatchObject({ outcome: 'unavailable', version: null });
        expect(uiUpdateCheckOf({ kind: 'refused', version, reason: 'hash-mismatch' }, at)).toMatchObject({
            outcome: 'refused',
            reason: 'hash-mismatch',
            revocationReason: null,
        });
        expect(
            uiUpdateCheckOf(
                { kind: 'refused', version, reason: 'revocations-unverifiable', revocationReason: 'rolled-back' },
                at,
            ),
        ).toMatchObject({ reason: 'revocations-unverifiable', revocationReason: 'rolled-back', eligibleAt: null });
    });

    it('reports when a delayed release becomes eligible, rounded up to the second', () => {
        const delayed = (eligibleAt: string) =>
            uiUpdateCheckOf(
                { kind: 'refused', version, reason: 'delay-not-elapsed', eligibleAt: new Date(eligibleAt) },
                at,
            );
        expect(delayed('2026-10-23T10:00:00.000Z')).toMatchObject({
            reason: 'delay-not-elapsed',
            eligibleAt: '2026-10-23T10:00:00Z',
        });
        expect(delayed('2026-10-23T10:00:00.001Z').eligibleAt).toBe('2026-10-23T10:00:01Z');
    });
});
