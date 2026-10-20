import { createHash } from 'node:crypto';

import { UiBundleManifest } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { MANIFEST_PATH, ManifestError, buildManifest, encodeManifest, engineApiRange } from './manifest.ts';

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const COMMIT = 'a'.repeat(40);

const dist = [
    { path: 'index.html', bytes: text('<!doctype html>') },
    { path: 'assets/index-BxD3f9_a.js', bytes: text('console.log(1)') },
    { path: 'assets/empty-Ab12Cd34.css', bytes: new Uint8Array(0) },
];

const input = { version: '0.1.0', commit: COMMIT, engineApiVersion: '1.1.0', csp: "default-src 'self'", files: dist };

describe('buildManifest', () => {
    it('lists exactly the dist/ files, sorted by bytes, with their SHA-256 and size', () => {
        const manifest = buildManifest(input);
        expect(manifest.files).toEqual([
            { path: 'assets/empty-Ab12Cd34.css', sha256: createHash('sha256').digest('hex'), size: 0 },
            {
                path: 'assets/index-BxD3f9_a.js',
                sha256: createHash('sha256').update('console.log(1)').digest('hex'),
                size: 14,
            },
            {
                path: 'index.html',
                sha256: createHash('sha256').update('<!doctype html>').digest('hex'),
                size: 15,
            },
        ]);
    });

    it('fills the other fields and nothing else', () => {
        const manifest = buildManifest(input);
        expect(Object.keys(manifest)).toEqual(['v', 'version', 'commit', 'engineApi', 'entry', 'files', 'csp']);
        expect(manifest).toMatchObject({
            v: 1,
            version: '0.1.0',
            commit: COMMIT,
            engineApi: '>=1.1.0 <2.0.0',
            entry: 'index.html',
            csp: "default-src 'self'",
        });
        expect(UiBundleManifest.safeParse(manifest).success).toBe(true);
    });

    it.each([
        ['a version that is not semver', { version: 'v1' }],
        ['a short commit', { commit: 'abc' }],
        ['no index.html', { files: dist.filter(({ path }) => path !== 'index.html') }],
        ['no files at all', { files: [] }],
        ['a path the schema refuses', { files: [...dist, { path: 'assets/.hidden', bytes: text('x') }] }],
        ['a CSP over 4 KiB', { csp: 'x'.repeat(4097) }],
    ])('refuses a schema-invalid manifest: %s', (_case, change) => {
        expect(() => buildManifest({ ...input, ...change })).toThrow(ManifestError);
    });

    it('refuses a dist/ that already has a manifest.json', () => {
        expect(() => buildManifest({ ...input, files: [...dist, { path: MANIFEST_PATH, bytes: text('{}') }] })).toThrow(
            /may not contain/,
        );
    });
});

describe('engineApiRange', () => {
    it('spans from the built-against version to the next major', () => {
        expect(engineApiRange('1.1.0')).toBe('>=1.1.0 <2.0.0');
        expect(engineApiRange('0.3.2')).toBe('>=0.3.2 <1.0.0');
    });

    it('refuses anything but X.Y.Z', () => {
        expect(() => engineApiRange('1.1')).toThrow(ManifestError);
        expect(() => engineApiRange('1.1.0-beta')).toThrow(ManifestError);
    });
});

describe('encodeManifest', () => {
    it('writes indented JSON with a trailing newline that parses back to the same manifest', () => {
        const manifest = buildManifest(input);
        const bytes = encodeManifest(manifest);
        const textValue = new TextDecoder().decode(bytes);
        expect(textValue.endsWith('}\n')).toBe(true);
        expect(JSON.parse(textValue)).toEqual(manifest);
    });
});
