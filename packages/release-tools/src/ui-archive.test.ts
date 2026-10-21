import { constants, zstdCompressSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { TarFile } from './tar';
import { TAR_LIMITS, TarFormatError, TarPathError, writeTar } from './tar';
import { UI_ARCHIVE_MANIFEST_PATH, decompressArchive, readUiArchive } from './ui-archive';

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const zstd = (bytes: Uint8Array): Uint8Array =>
    zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 3 } });

const files: TarFile[] = [
    { path: UI_ARCHIVE_MANIFEST_PATH, bytes: text('{"v":1}') },
    { path: 'index.html', bytes: text('<!doctype html>') },
    { path: 'assets/index-BxD3f9_a.js', bytes: text('console.log(1)') },
];

function archive(input: readonly TarFile[] = files, first = UI_ARCHIVE_MANIFEST_PATH): Uint8Array {
    return zstd(writeTar(input, { mtime: 0, first }));
}

describe('readUiArchive', () => {
    it('returns the manifest bytes and every other file', () => {
        const read = readUiArchive(archive());
        expect(read.manifestBytes).toEqual(text('{"v":1}'));
        expect([...read.files.keys()].sort()).toEqual(['assets/index-BxD3f9_a.js', 'index.html']);
        expect(read.files.get('index.html')).toEqual(text('<!doctype html>'));
    });

    it('refuses an archive whose first entry is not the manifest', () => {
        expect(() => readUiArchive(archive(files, 'index.html'))).toThrow(TarFormatError);
        expect(() => readUiArchive(zstd(new Uint8Array(1024)))).toThrow(/first entry/);
    });

    it('refuses bytes that are not zstd', () => {
        expect(() => readUiArchive(text('not zstd'))).toThrow(TarFormatError);
    });

    it('passes on the tar reader’s refusals', () => {
        const tar = writeTar(files, { mtime: 0, first: UI_ARCHIVE_MANIFEST_PATH });
        // Turn index.html's header into a symlink entry (type flag at offset 156 of its block), checksum fixed.
        const tampered = tar.slice();
        const offsets = [...Array(tar.length / 512).keys()].map((index) => index * 512);
        const header = offsets.find(
            (offset) => new TextDecoder().decode(tar.subarray(offset, offset + 10)) === 'index.html',
        );
        if (header === undefined) throw new Error('no index.html header');
        tampered[header + 156] = '2'.charCodeAt(0);
        tampered.fill(0x20, header + 148, header + 156);
        const sum = tampered.subarray(header, header + 512).reduce((total, byte) => total + byte, 0);
        tampered.set(text(`${sum.toString(8).padStart(6, '0')}\0 `), header + 148);
        expect(() => readUiArchive(zstd(tampered))).toThrow(/not a regular file/);
    });
});

describe('decompressArchive', () => {
    it('stops at the largest tar the reader accepts instead of allocating a zstd bomb', () => {
        const bomb = zstd(new Uint8Array(TAR_LIMITS.maxUnpackedBytes + 17 * 1024 * 1024));
        expect(bomb.length).toBeLessThan(1024 * 1024);
        expect(() => decompressArchive(bomb)).toThrow();
    });
});

it('keeps TarPathError for unsafe paths', () => {
    expect(() => writeTar([{ path: '../x', bytes: text('') }], { mtime: 0, first: '../x' })).toThrow(TarPathError);
});
