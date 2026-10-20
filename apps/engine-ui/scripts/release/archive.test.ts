import { describe, expect, it } from 'vitest';

import { compressArchive, packBundle, parseManifest, unpackBundle } from './archive.ts';
import { MANIFEST_PATH, encodeManifest } from './manifest.ts';
import { TarFormatError, readTar, writeTar } from './tar.ts';
import { decompressArchive } from './archive.ts';

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

const input = {
    version: '0.1.0',
    commit: 'b'.repeat(40),
    engineApiVersion: '1.1.0',
    csp: "default-src 'self'",
    mtime: 1_760_000_000,
    files: [
        { path: 'index.html', bytes: text('<!doctype html>') },
        { path: 'assets/index-BxD3f9_a.js', bytes: text('console.log(1)') },
    ],
};

describe('packBundle', () => {
    it('is deterministic and independent of the file order', () => {
        const a = packBundle(input);
        const b = packBundle({ ...input, files: [...input.files].reverse() });
        expect(b.archive).toEqual(a.archive);
        expect(b.manifestBytes).toEqual(a.manifestBytes);
    });

    it('writes a zstd frame whose tar starts with the manifest bytes', () => {
        const packed = packBundle(input);
        expect([...packed.archive.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
        const [first] = readTar(decompressArchive(packed.archive));
        expect(first?.path).toBe(MANIFEST_PATH);
        expect(first?.bytes).toEqual(packed.manifestBytes);
        expect(packed.manifestBytes).toEqual(encodeManifest(packed.manifest));
    });

    it('changes when one file byte changes', () => {
        const changed = packBundle({ ...input, files: [{ path: 'index.html', bytes: text('<!doctype htmL>') }] });
        expect(changed.archive).not.toEqual(packBundle(input).archive);
    });
});

describe('unpackBundle', () => {
    it('returns the manifest and every other file', () => {
        const unpacked = unpackBundle(packBundle(input).archive);
        expect(unpacked.manifest.version).toBe('0.1.0');
        expect([...unpacked.files.keys()]).toEqual(['assets/index-BxD3f9_a.js', 'index.html']);
        expect(unpacked.files.get('index.html')).toEqual(text('<!doctype html>'));
    });

    it('refuses an archive whose first entry is not the manifest', () => {
        const tar = writeTar(input.files, { mtime: 0, first: 'index.html' });
        expect(() => unpackBundle(compressArchive(tar))).toThrow(/first entry/);
    });

    it('refuses a manifest that does not parse', () => {
        const tar = writeTar([{ path: MANIFEST_PATH, bytes: text('{"v":2}') }, ...input.files], {
            mtime: 0,
            first: MANIFEST_PATH,
        });
        expect(() => unpackBundle(compressArchive(tar))).toThrow(TarFormatError);
    });

    it('refuses bytes that are not zstd', () => {
        expect(() => unpackBundle(text('not zstd'))).toThrow();
    });
});

describe('parseManifest', () => {
    it('refuses invalid UTF-8, invalid JSON and unknown fields', () => {
        const valid = packBundle(input).manifest;
        expect(parseManifest(Uint8Array.of(0xff))).toBeUndefined();
        expect(parseManifest(text('{'))).toBeUndefined();
        expect(parseManifest(text(JSON.stringify({ ...valid, extra: 1 })))).toBeUndefined();
        expect(parseManifest(text(JSON.stringify(valid)))).toEqual(valid);
    });
});
