import { describe, expect, it } from 'vitest';
import type { Bytes } from '../bytes';
import { utf8Encode } from '../bytes';
import { toHex } from '../testing/hex';
import { Artifact } from './entry';
import { BundlePath, UiBundleManifest, satisfiesEngineApiRange } from './manifest';
import { verifyArtifact, verifyManifestFiles } from './verify';
import vectors from './vectors.json';

async function sha256Hex(bytes: Bytes): Promise<string> {
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

const INDEX = utf8Encode('<!doctype html><script src="assets/index-abc.js"></script>');
const SCRIPT = utf8Encode('console.log("ui");');

async function fileEntry(path: string, bytes: Bytes) {
    return { path, sha256: await sha256Hex(bytes), size: bytes.length };
}

async function manifestJson(fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return {
        v: 1,
        version: '2.0.0',
        commit: '0123456789abcdef0123456789abcdef01234567',
        engineApi: '>=1.0.0 <2.0.0',
        entry: 'index.html',
        files: [await fileEntry('index.html', INDEX), await fileEntry('assets/index-abc.js', SCRIPT)],
        csp: "default-src 'self'",
        ...fields,
    };
}

const file = (path: string, size = 1) => ({ path, sha256: 'ab'.repeat(32), size });

describe('UiBundleManifest', () => {
    it('accepts a valid manifest', async () => {
        expect(UiBundleManifest.safeParse(await manifestJson()).success).toBe(true);
    });

    it.each([['>=1.0.0'], ['<2.0.0'], ['^1.2.3'], ['>=1.0.0 <2.0.0'], ['^0.0.1 >=0.0.1 <1.0.0']])(
        'accepts engineApi %j',
        async (engineApi) => {
            expect(UiBundleManifest.safeParse(await manifestJson({ engineApi })).success).toBe(true);
        },
    );

    it.each([
        ['>=1.0'],
        ['~1.0.0'],
        ['>1.0.0'],
        ['<=1.0.0'],
        ['=1.0.0'],
        ['1.0.0'],
        ['>=1.0.0  <2.0.0'],
        [' >=1.0.0'],
        ['>=1.0.0 '],
        ['>= 1.0.0'],
        ['>=01.0.0'],
        ['>=1.0.0-rc.1'],
        ['>=1.0.0+build'],
        ['>=1.0.0 || <0.5.0'],
        ['*'],
        [''],
    ])('rejects engineApi %j', async (engineApi) => {
        expect(UiBundleManifest.safeParse(await manifestJson({ engineApi })).success).toBe(false);
    });

    it.each([
        ['an unknown field', { extra: 1 }],
        ['a short commit', { commit: '0123456' }],
        ['v 2', { v: 2 }],
        ['a non-SemVer version', { version: 'v2' }],
        ['a negative size', { files: [file('index.html', -1)] }],
        ['a fractional size', { files: [file('index.html', 1.5)] }],
        ['an unsafe size', { files: [file('index.html', Number.MAX_SAFE_INTEGER + 1)] }],
        ['an uppercase sha256', { files: [{ ...file('index.html'), sha256: 'AB'.repeat(32) }] }],
        ['an unknown file field', { files: [{ ...file('index.html'), mode: 0o644 }] }],
        ['another entry', { entry: 'main.html', files: [file('main.html')] }],
        ['an entry that is not listed', { files: [file('app.js')] }],
        ['duplicate paths', { files: [file('index.html'), file('index.html')] }],
        ['no files', { files: [] }],
        ['a non-string csp', { csp: null }],
    ])('rejects %s', async (_, fields) => {
        expect(UiBundleManifest.safeParse(await manifestJson(fields)).success).toBe(false);
    });

    it('rejects a missing commit', async () => {
        const value = await manifestJson();
        delete value['commit'];
        expect(UiBundleManifest.safeParse(value).success).toBe(false);
    });

    it.each([
        ['../x'],
        ['a/../x'],
        ['a/..'],
        ['/x'],
        ['a\\b'],
        ['a//b'],
        ['a/'],
        [''],
        ['./x'],
        ['a/./b'],
        ['.'],
        ['a\nb'],
        ['a\0b'],
        ['a\x7fb'],
        ['x'.repeat(1025)],
        ['.well-known/x'],
        ['.hidden'],
        ['assets/.env'],
        ['a?b'],
        ['a#b'],
        ['a%2e%2e/b'],
        ['café.js'],
        ['a b'],
        ['a:b'],
        ['a/\u0430.js'],
    ])('rejects the path %j', async (path) => {
        expect(BundlePath.safeParse(path).success).toBe(false);
        const files = [file('index.html'), file(path)];
        expect(UiBundleManifest.safeParse(await manifestJson({ files })).success).toBe(false);
    });

    it.each([
        ['assets/index-abc.js'],
        ['assets/index-BxD3f9_a.js'],
        ['assets/vendor-Ck2-vL9P.css'],
        ['assets/logo-DM0aLk7k.svg'],
        ['index.html'],
        ['a..b/c'],
        ['x'.repeat(1024)],
    ])('accepts the path %j', async (path) => {
        expect(BundlePath.safeParse(path).success).toBe(true);
        const files = [file('index.html'), file(path === 'index.html' ? 'other' : path)];
        expect(UiBundleManifest.safeParse(await manifestJson({ files })).success).toBe(true);
    });
});

describe('satisfiesEngineApiRange', () => {
    it.each([
        ['>=1.0.0 <2.0.0', '1.1.0', true],
        ['>=1.0.0 <2.0.0', '1.0.0', true],
        ['>=1.0.0 <2.0.0', '2.0.0', false],
        ['>=1.0.0 <2.0.0', '0.9.9', false],
        ['^1.2.0', '1.2.0', true],
        ['^1.2.0', '1.9.9', true],
        ['^1.2.0', '2.0.0', false],
        ['^1.2.0', '1.1.9', false],
        ['^0.2.3', '0.2.9', true],
        ['^0.2.3', '0.2.2', false],
        ['^0.2.3', '0.3.0', false],
        ['^0.0.3', '0.0.3', true],
        ['^0.0.3', '0.0.4', false],
        ['>=1.0.0 <2.0.0', '1.0', false],
        ['>=1.0.0 <2.0.0', '1.0.0-rc.1', false],
        ['>=1.0.0 <2.0.0', '1.10.0', true],
    ] as const)('%s with %s is %s', (range, version, expected) => {
        expect(satisfiesEngineApiRange(range, version)).toBe(expected);
    });

    it('is false for a range that never passed its schema', () => {
        expect(satisfiesEngineApiRange('~1.0.0', '1.0.0')).toBe(false);
        expect(satisfiesEngineApiRange('>=1.0.0  <2.0.0', '1.0.0')).toBe(false);
    });
});

describe('verifyArtifact', () => {
    const artifact = Artifact.parse({ name: 'engine-ui.tar.zst', sha256: vectors.artifact.sha256, kind: 'ui' });

    it('accepts the bytes the entry pins', async () => {
        expect(await verifyArtifact(artifact, utf8Encode(vectors.artifact.text))).toEqual({ kind: 'ok' });
    });

    it('refuses bytes with one byte changed', async () => {
        const bytes = utf8Encode(vectors.artifact.text);
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        expect(await verifyArtifact(artifact, bytes)).toEqual({ kind: 'hash-mismatch', name: 'engine-ui.tar.zst' });
    });

    it('refuses empty bytes', async () => {
        expect(await verifyArtifact(artifact, new Uint8Array())).toEqual({
            kind: 'hash-mismatch',
            name: 'engine-ui.tar.zst',
        });
    });
});

describe('verifyManifestFiles', () => {
    const manifest = async () => UiBundleManifest.parse(await manifestJson());
    const files = (entries: [string, Bytes][]) => new Map(entries);

    it('accepts exactly the listed files', async () => {
        const unpacked = files([
            ['index.html', INDEX],
            ['assets/index-abc.js', SCRIPT],
        ]);
        expect(await verifyManifestFiles(await manifest(), unpacked)).toEqual({ kind: 'ok' });
    });

    it('refuses a missing file', async () => {
        expect(await verifyManifestFiles(await manifest(), files([['index.html', INDEX]]))).toEqual({
            kind: 'missing-file',
            name: 'assets/index-abc.js',
        });
    });

    it('refuses a file the manifest does not list', async () => {
        const unpacked = files([
            ['index.html', INDEX],
            ['assets/index-abc.js', SCRIPT],
            ['assets/evil.js', SCRIPT],
        ]);
        expect(await verifyManifestFiles(await manifest(), unpacked)).toEqual({
            kind: 'unexpected-file',
            name: 'assets/evil.js',
        });
    });

    it('refuses a file of another size', async () => {
        const unpacked = files([
            ['index.html', INDEX],
            ['assets/index-abc.js', utf8Encode('console.log("ui"); ')],
        ]);
        expect(await verifyManifestFiles(await manifest(), unpacked)).toEqual({
            kind: 'hash-mismatch',
            name: 'assets/index-abc.js',
        });
    });

    it('refuses a file of the same size with other bytes', async () => {
        const unpacked = files([
            ['index.html', INDEX],
            ['assets/index-abc.js', utf8Encode('console.log("UI");')],
        ]);
        expect(await verifyManifestFiles(await manifest(), unpacked)).toEqual({
            kind: 'hash-mismatch',
            name: 'assets/index-abc.js',
        });
    });
});
