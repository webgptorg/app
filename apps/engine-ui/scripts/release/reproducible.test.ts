import { describe, expect, it } from 'vitest';

import { compressArchive, packBundle } from './archive.ts';
import { compareArchives, firstDifference } from './reproducible.ts';
import { writeTar } from './tar.ts';

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const input = {
    version: '0.1.0',
    commit: 'c'.repeat(40),
    engineApiVersion: '1.1.0',
    csp: '',
    mtime: 1_760_000_000,
    files: [
        { path: 'index.html', bytes: text('<!doctype html>') },
        { path: 'assets/a-12345678.js', bytes: text('a') },
        { path: 'assets/b-12345678.js', bytes: text('b') },
    ],
};

describe('firstDifference', () => {
    it('finds the first changed, missing or extra path in byte order', () => {
        const base = input.files;
        expect(firstDifference(base, [...base].reverse())).toBeUndefined();
        expect(
            firstDifference(
                base,
                base.map((f) => (f.path === 'index.html' ? { ...f, bytes: text('x') } : f)),
            ),
        ).toBe('index.html');
        expect(firstDifference(base, base.slice(0, 2))).toBe('assets/b-12345678.js');
        expect(firstDifference(base, [...base, { path: 'Z.js', bytes: text('z') }])).toBe('Z.js');
    });
});

describe('compareArchives', () => {
    it('reports identical archives with their SHA-256', () => {
        const archive = packBundle(input).archive;
        expect(compareArchives(archive, archive.slice())).toMatchObject({ kind: 'identical' });
    });

    it('names the first differing file, e.g. one with a build timestamp', () => {
        const a = packBundle(input).archive;
        const b = packBundle({
            ...input,
            files: input.files.map((f) =>
                f.path === 'assets/b-12345678.js' ? { ...f, bytes: text(`b${String(Date.now())}`) } : f,
            ),
        }).archive;
        const check = compareArchives(a, b);
        expect(check.kind).toBe('different');
        expect(check.kind === 'different' && check.detail).toMatch(/first differing file: assets\/b-12345678\.js$/);
    });

    it('reports archives that differ only in framing', () => {
        const a = packBundle(input).archive;
        const b = packBundle({ ...input, mtime: input.mtime + 1 }).archive;
        expect(JSON.stringify(compareArchives(a, b))).toMatch(/archive framing/);
    });

    it('reports an archive that does not unpack', () => {
        const a = packBundle(input).archive;
        const broken = compressArchive(writeTar(input.files, { mtime: 0, first: 'index.html' }).subarray(0, 600));
        expect(JSON.stringify(compareArchives(a, broken))).toMatch(/does not unpack/);
    });
});
