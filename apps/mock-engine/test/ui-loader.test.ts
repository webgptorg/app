import { ENGINE_API_PREFIX, ENGINE_UI_CSP, SIGN_IN_PATH } from '@ptbk/engine-api';
import { EngineVersion } from '@ptbk/protocol';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { UiLoader } from '../src/domain/ui/ui-loader';
import { createUiLoader } from '../src/domain/ui/ui-loader';
import type { UiUpdateOutcome } from '../src/domain/ui/ui-update';
import { uiUpdateCheckOf } from '../src/domain/ui/ui-update';
import type { ApiHarness } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';
import { createFakeClock } from '../src/testing/fake-clock';
import { createMemoryBundleStore } from '../src/testing/memory-bundle-store';
import type { MemoryReleaseSource } from '../src/testing/memory-release-source';
import { createMemoryReleaseSource } from '../src/testing/memory-release-source';
import { createMemoryUpdateStateStore } from '../src/testing/memory-update-state-store';
import { createMemoryLogger } from '../src/testing/memory-logger';
import { createSeededRandom } from '../src/testing/seeded-random';
import type { TestBundleInput, TestReleaseKeys } from '../src/testing/ui-releases';
import {
    TEST_ARCHIVE_NAME,
    TEST_BUNDLE_FILES,
    buildTestBundle,
    createTestProvenanceVerifier,
    createTestReleaseKeys,
    signTestRelease,
    signTestRevocations,
} from '../src/testing/ui-releases';

const HOUR = 3_600_000;
// The harness's TLS certificates use the real clock, so the loader's fake clock starts at the real time.
const NOW = Date.now();
const HTML = 'text/html,application/xhtml+xml';

let keys: TestReleaseKeys;
beforeAll(async () => {
    keys = await createTestReleaseKeys();
});

let harness: ApiHarness | undefined;
afterEach(async () => {
    await harness?.close();
    harness = undefined;
});

interface Engine {
    readonly harness: ApiHarness;
    readonly loader: UiLoader;
    readonly source: MemoryReleaseSource;
    readonly owner: string;
    publish(
        version: string,
        bundle?: Partial<TestBundleInput>,
        serve?: (archive: Uint8Array) => Uint8Array,
    ): Promise<string>;
    /** Publishes a fresh revocation list naming these versions. */
    revoke(...versions: string[]): Promise<void>;
}

async function start(options: { readonly pinned?: string } = {}): Promise<Engine> {
    const clock = createFakeClock(NOW);
    const source = createMemoryReleaseSource();
    source.setRevocations(
        await signTestRevocations(keys, { issuedAt: new Date(NOW - HOUR), expiresAt: new Date(NOW + 24 * HOUR) }),
    );
    const store = createMemoryBundleStore();
    let onActive: (info: { version: string; sha256: string; logIndex: number } | undefined) => void = () => undefined;
    let onChecked: (outcome: UiUpdateOutcome, atMs: number) => void = () => undefined;
    const loader = createUiLoader({
        updatePolicy:
            options.pinned === undefined
                ? { kind: 'manual' }
                : { kind: 'pinned', version: EngineVersion.parse(options.pinned) },
        checkIntervalS: 3600,
        deps: {
            source,
            store,
            state: createMemoryUpdateStateStore(),
            provenance: createTestProvenanceVerifier(),
            trust: keys.policy,
        },
        clock,
        random: createSeededRandom(1),
        logger: createMemoryLogger(),
        onActive: (bundle) => {
            onActive(bundle);
        },
        onChecked: (outcome, atMs) => {
            onChecked(outcome, atMs);
        },
    });
    harness = await createApiHarness({ bundles: store, ui: loader });
    const runtime = harness.runtime;
    onActive = (bundle) =>
        runtime?.setUi(
            bundle === undefined
                ? null
                : { version: bundle.version, bundleSha256: bundle.sha256, releaseLogIndex: bundle.logIndex },
        );
    onChecked = (outcome, atMs) => runtime?.setUiUpdateCheck(uiUpdateCheckOf(outcome, atMs));
    return {
        harness,
        loader,
        source,
        owner: harness.signIn({ memberId: harness.ownerId() }),
        async publish(version, bundleInput = {}, serve) {
            const bundle = buildTestBundle({ version, ...bundleInput });
            const record = await signTestRelease(keys, {
                version,
                archiveSha256: bundle.sha256,
                publishedAt: new Date(NOW - 100 * HOUR),
            });
            source.publish(EngineVersion.parse(version), {
                record,
                artifacts: new Map([[TEST_ARCHIVE_NAME, serve?.(bundle.archive) ?? bundle.archive]]),
            });
            return bundle.sha256;
        },
        async revoke(...versions) {
            source.setRevocations(
                await signTestRevocations(keys, {
                    issuedAt: new Date(NOW),
                    expiresAt: new Date(NOW + 24 * HOUR),
                    revoked: versions.map((version) => ({ version, reason: 'compromised' })),
                }),
            );
        },
    };
}

const IGNORED = new Set([
    'date',
    'connection',
    'keep-alive',
    'content-length',
    'transfer-encoding',
    'set-cookie',
    'location',
]);

/** Every header a response carries, except the ones that vary per request or message. */
function headerMap(response: Response): Record<string, string> {
    return Object.fromEntries([...response.headers].filter(([name]) => !IGNORED.has(name)).sort());
}

async function get(engine: Engine, path: string, cookie: string | null, accept = HTML): Promise<Response> {
    return engine.harness.fetch(cookie)(`${HARNESS_ORIGIN}${path}`, { headers: { accept } });
}

describe('UI routes', () => {
    it('answer 503 with a plain engine page until a bundle installs, and serve it after', async () => {
        const engine = await start();
        const before = await get(engine, '/', engine.owner);
        expect(before.status).toBe(503);
        expect(await before.text()).toContain('The app is unavailable');

        await engine.publish('1.0.0');
        expect(await engine.loader.checkNow()).toMatchObject({ kind: 'installed' });
        const after = await get(engine, '/', engine.owner);
        expect(after.status).toBe(200);
        expect(await after.text()).toBe(new TextDecoder().decode(TEST_BUNDLE_FILES[0]?.bytes));
    });

    it('send hashed assets as immutable, the entry as no-cache, with types from the fixed map', async () => {
        const engine = await start();
        await engine.publish('1.0.0');
        await engine.loader.checkNow();
        const script = await get(engine, '/assets/index-BxD3f9_a.js', engine.owner, '*/*');
        expect(script.status).toBe(200);
        expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
        expect(await script.text()).toBe('document.body.dataset.ui = "test";\n');
        const entry = await get(engine, '/index.html', engine.owner);
        expect(entry.headers.get('cache-control')).toBe('no-cache');
        const icon = await get(engine, '/favicon.svg', engine.owner, '*/*');
        expect(icon.headers.get('cache-control')).toBe('no-cache');
        expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    });

    it('fall back to the entry for client-side routes, and never for assets, API paths or other methods', async () => {
        const engine = await start();
        await engine.publish('1.0.0');
        await engine.loader.checkNow();
        const route = await get(engine, '/agents/123?tab=book', engine.owner);
        expect(route.status).toBe(200);
        expect(route.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(route.headers.get('cache-control')).toBe('no-cache');

        for (const path of ['/assets/missing.js', `${ENGINE_API_PREFIX}/nothing-here`, '/.well-known/x', '/setup']) {
            expect((await get(engine, path, engine.owner)).status, path).toBe(404);
        }
        expect((await get(engine, '/agents/123', engine.owner, 'application/json')).status).toBe(404);
        const post = await engine.harness.fetch(engine.owner)(`${HARNESS_ORIGIN}/agents/123`, {
            method: 'POST',
            headers: { accept: HTML },
        });
        expect(post.status).toBe(404);
    });

    it('answer HEAD like GET, without a body', async () => {
        const engine = await start();
        await engine.publish('1.0.0');
        await engine.loader.checkNow();
        const head = await engine.harness.fetch(engine.owner)(`${HARNESS_ORIGIN}/`, { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(head.headers.get('content-security-policy')).toBe(ENGINE_UI_CSP);
        expect(await head.text()).toBe('');
    });

    it('give an anonymous visitor only the sign-in redirect, and the API a 401', async () => {
        const engine = await start();
        await engine.publish('1.0.0');
        await engine.loader.checkNow();
        for (const [path, location] of [
            ['/', SIGN_IN_PATH],
            ['/assets/index-BxD3f9_a.js', `${SIGN_IN_PATH}?next=%2Fassets%2Findex-BxD3f9_a.js`],
            ['/agents/1', `${SIGN_IN_PATH}?next=%2Fagents%2F1`],
        ] as const) {
            const response = await get(engine, path, null);
            expect(response.status, path).toBe(303);
            expect(response.headers.get('location')).toBe(location);
        }
        expect((await get(engine, `${ENGINE_API_PREFIX}/me`, null, 'application/json')).status).toBe(401);
    });

    it('serve a bundle whose manifest csp differs with ENGINE_UI_CSP, never the manifest’s', async () => {
        const engine = await start();
        await engine.publish('1.0.0', { csp: "default-src *; script-src 'unsafe-eval'" });
        expect(await engine.loader.checkNow()).toMatchObject({ kind: 'installed' });
        for (const path of ['/', '/assets/index-BxD3f9_a.js']) {
            expect((await get(engine, path, engine.owner)).headers.get('content-security-policy')).toBe(ENGINE_UI_CSP);
        }
    });
});

describe('engine-owned paths', () => {
    it('are never served from a bundle, even one whose manifest lists them', async () => {
        const files = [
            ...TEST_BUNDLE_FILES,
            { path: 'auth/planted', bytes: new TextEncoder().encode('planted') },
            { path: 'api/v1/planted', bytes: new TextEncoder().encode('planted') },
            { path: '__mock/planted', bytes: new TextEncoder().encode('planted') },
            { path: 'setup', bytes: new TextEncoder().encode('planted') },
        ];
        const { manifest } = buildTestBundle({ version: '1.0.0', files });
        const bundle = {
            id: 'planted',
            version: EngineVersion.parse('1.0.0'),
            sha256: '0'.repeat(64),
            logIndex: 1,
            manifest,
        };
        const bytes = new Map(files.map((file) => [file.path, file.bytes]));
        harness = await createApiHarness({
            bundles: { active: () => bundle, read: (_bundle, path) => Promise.resolve(bytes.get(path)) },
        });
        const owner = harness.signIn({ memberId: harness.ownerId() });
        for (const path of ['/auth/planted', `${ENGINE_API_PREFIX}/planted`, '/__mock/planted', '/setup']) {
            const response = await harness.fetch(owner)(`${HARNESS_ORIGIN}${path}`, { headers: { accept: HTML } });
            expect(response.status, path).toBe(404);
            expect(await response.text(), path).not.toContain('planted');
        }
        expect((await harness.fetch(owner)(`${HARNESS_ORIGIN}/`, { headers: { accept: HTML } })).status).toBe(200);
    });

    it('make a manifest that claims one a manifest refusal at install', async () => {
        const engine = await start();
        await engine.publish('1.0.0', {
            files: [...TEST_BUNDLE_FILES, { path: 'auth/sign-in', bytes: new TextEncoder().encode('fake sign-in') }],
        });
        expect(await engine.loader.checkNow()).toMatchObject({ kind: 'refused', reason: 'manifest' });
        expect(engine.loader.store.active()).toBeUndefined();
    });
});

describe('security headers on every in-tunnel response', () => {
    it('are the full engine set on 200, 404, 401, 303 and 503 (header map snapshot)', async () => {
        const engine = await start();
        const unavailable = await get(engine, '/', engine.owner);
        expect(unavailable.status).toBe(503);
        expect(headerMap(unavailable)).toMatchInlineSnapshot(`
          {
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ptbk-html",
            "content-type": "text/html; charset=utf-8",
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-resource-policy": "same-origin",
            "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            "referrer-policy": "no-referrer",
            "strict-transport-security": "max-age=31536000",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
          }
        `);

        await engine.publish('1.0.0');
        await engine.loader.checkNow();
        const ok = await get(engine, '/assets/index-BxD3f9_a.js', engine.owner, '*/*');
        expect(ok.status).toBe(200);
        expect(headerMap(ok)).toMatchInlineSnapshot(`
          {
            "cache-control": "public, max-age=31536000, immutable",
            "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ptbk-html",
            "content-type": "text/javascript; charset=utf-8",
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-resource-policy": "same-origin",
            "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            "referrer-policy": "no-referrer",
            "strict-transport-security": "max-age=31536000",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
          }
        `);

        const missing = await get(engine, '/assets/missing.js', engine.owner);
        expect(missing.status).toBe(404);
        expect(headerMap(missing)).toMatchInlineSnapshot(`
          {
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ptbk-html",
            "content-type": "application/problem+json",
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-resource-policy": "same-origin",
            "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            "referrer-policy": "no-referrer",
            "strict-transport-security": "max-age=31536000",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
          }
        `);

        const unauthenticated = await get(engine, `${ENGINE_API_PREFIX}/me`, null, 'application/json');
        expect(unauthenticated.status).toBe(401);
        expect(headerMap(unauthenticated)).toMatchInlineSnapshot(`
          {
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ptbk-html",
            "content-type": "application/problem+json",
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-resource-policy": "same-origin",
            "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            "referrer-policy": "no-referrer",
            "strict-transport-security": "max-age=31536000",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
          }
        `);

        const redirect = await get(engine, '/', null);
        expect(redirect.status).toBe(303);
        expect(headerMap(redirect)).toMatchInlineSnapshot(`
          {
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types ptbk-html",
            "content-type": "text/plain; charset=UTF-8",
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-resource-policy": "same-origin",
            "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            "referrer-policy": "no-referrer",
            "strict-transport-security": "max-age=31536000",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
          }
        `);
    });
});

describe('security panel and control listener', () => {
    it('report the active bundle’s version, archive SHA-256 and release log index', async () => {
        const engine = await start();
        const sha256 = await engine.publish('1.0.0');
        await engine.loader.checkNow();
        const overview = await engine.harness.client(engine.owner).security.get(new AbortController().signal);
        if (overview.kind !== 'ok') throw new Error('no security overview');
        expect(overview.data.ui).toEqual({
            version: '1.0.0',
            bundleSha256: sha256,
            releaseLogIndex: 4242,
            releaseLogEntryUuid: null,
            lastUpdateCheck: {
                at: new Date(NOW).toISOString().replace(/\.\d{3}Z$/, 'Z'),
                outcome: 'installed',
                version: '1.0.0',
                reason: null,
                revocationReason: null,
                eligibleAt: null,
            },
        });
    });

    it('stop serving a revoked active bundle: the previous one comes back, then the plain page', async () => {
        const engine = await start({ pinned: '1.0.0' });
        const first = await engine.publish('1.0.0');
        await engine.loader.checkNow();
        await engine.publish('1.1.0', { files: [...TEST_BUNDLE_FILES, { path: 'new.txt', bytes: new Uint8Array(1) }] });
        engine.loader.pin(EngineVersion.parse('1.1.0'));
        expect(await engine.loader.checkNow()).toMatchObject({ kind: 'installed', version: '1.1.0' });
        expect((await get(engine, '/new.txt', engine.owner, '*/*')).status).toBe(200);
        const panel = async () => {
            const overview = await engine.harness.client(engine.owner).security.get(new AbortController().signal);
            if (overview.kind !== 'ok') throw new Error('no security overview');
            return overview.data.ui;
        };
        const placeholder = await (async () => {
            const fresh = await createApiHarness({});
            try {
                const overview = await fresh
                    .client(fresh.signIn({ memberId: fresh.ownerId() }))
                    .security.get(new AbortController().signal);
                if (overview.kind !== 'ok') throw new Error('no security overview');
                return overview.data.ui;
            } finally {
                await fresh.close();
            }
        })();

        await engine.revoke('1.1.0');
        expect(await engine.loader.checkNow()).toEqual({ kind: 'refused', version: '1.1.0', reason: 'revoked' });
        expect((await get(engine, '/new.txt', engine.owner, '*/*')).status).toBe(404);
        expect((await get(engine, '/', engine.owner)).status).toBe(200);
        expect(await panel()).toMatchObject({
            version: '1.0.0',
            bundleSha256: first,
            lastUpdateCheck: { outcome: 'refused', version: '1.1.0', reason: 'revoked', eligibleAt: null },
        });

        await engine.revoke('1.0.0', '1.1.0');
        await engine.loader.checkNow();
        const page = await get(engine, '/', engine.owner);
        expect(page.status).toBe(503);
        expect(await page.text()).toContain('The app is unavailable');
        const withdrawn = await panel();
        expect(withdrawn).toEqual({ ...placeholder, lastUpdateCheck: withdrawn.lastUpdateCheck });
        expect(withdrawn.lastUpdateCheck).toMatchObject({ outcome: 'refused', version: '1.0.0', reason: 'revoked' });
    });

    it('run a check on POST /__mock/ui/check, re-pin under pinned, and keep the old bundle on a refusal', async () => {
        const engine = await start({ pinned: '1.0.0' });
        const good = await engine.publish('1.0.0');
        await engine.publish('1.1.0', {}, (archive) => {
            const tampered = archive.slice();
            tampered[tampered.length - 3] = (tampered[tampered.length - 3] ?? 0) ^ 1;
            return tampered;
        });
        const control = await engine.harness.startControl();
        const post = (body: unknown) =>
            fetch(`http://127.0.0.1:${String(control.port)}/__mock/ui/check`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });

        const first = await post({});
        expect(first.status).toBe(200);
        expect(await first.json()).toMatchObject({
            outcome: { kind: 'installed', version: '1.0.0', sha256: good },
            active: { version: '1.0.0', sha256: good, logIndex: 4242 },
            policy: { kind: 'pinned', version: '1.0.0' },
        });

        const tampered = await post({ pinnedVersion: '1.1.0' });
        expect(await tampered.json()).toMatchObject({
            outcome: { kind: 'refused', version: '1.1.0', reason: 'hash-mismatch' },
            active: { version: '1.0.0' },
            policy: { kind: 'pinned', version: '1.1.0' },
        });
        expect((await get(engine, '/', engine.owner)).status).toBe(200);

        const status = await fetch(`http://127.0.0.1:${String(control.port)}/__mock/ui`);
        expect(await status.json()).toMatchObject({
            active: { version: '1.0.0' },
            lastOutcome: { reason: 'hash-mismatch' },
        });
        const overview = await engine.harness.client(engine.owner).security.get(new AbortController().signal);
        if (overview.kind !== 'ok') throw new Error('no security overview');
        expect(overview.data.ui).toMatchObject({
            version: '1.0.0',
            bundleSha256: good,
            lastUpdateCheck: { outcome: 'refused', version: '1.1.0', reason: 'hash-mismatch', revocationReason: null },
        });
        expect((await post({ pinnedVersion: 'not a version' })).status).toBe(400);
    });

    it('refuse a re-pin unless the policy is pinned', async () => {
        const engine = await start();
        const control = await engine.harness.startControl();
        const response = await fetch(`http://127.0.0.1:${String(control.port)}/__mock/ui/check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pinnedVersion: '1.0.0' }),
        });
        expect(response.status).toBe(400);
    });
});
