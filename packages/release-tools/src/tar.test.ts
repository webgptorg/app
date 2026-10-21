import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TarFile } from './tar';
import { TAR_LIMITS, TarFormatError, TarPathError, assertSafePath, readTar, readTree, writeTar } from './tar';

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const MTIME = 1_760_000_000;

const files: TarFile[] = [
    { path: 'manifest.json', bytes: text('{"v":1}\n') },
    { path: 'index.html', bytes: text('<!doctype html>') },
    { path: 'assets/index-BxD3f9_a.js', bytes: text('console.log(1)') },
    { path: 'assets/fonts/inter-Ab12Cd34.woff2', bytes: new Uint8Array(1300).fill(7) },
    { path: 'assets/Z-upper.css', bytes: text('a{}') },
];

function archive(input: readonly TarFile[] = files): Uint8Array {
    return writeTar(input, { mtime: MTIME, first: 'manifest.json' });
}

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ptbk-tar-'));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('writeTar', () => {
    it('writes the same bytes for the same files in any order', () => {
        const reversed = [...files].reverse();
        const shuffled = [files[2], files[0], files[4], files[1], files[3]].filter((file) => file !== undefined);
        expect(archive(reversed)).toEqual(archive());
        expect(archive(shuffled)).toEqual(archive());
    });

    it('puts the first entry first, then directories and files in byte order', () => {
        expect(readTar(archive()).map(({ path }) => path)).toEqual([
            'manifest.json',
            'assets/Z-upper.css',
            'assets/fonts/inter-Ab12Cd34.woff2',
            'assets/index-BxD3f9_a.js',
            'index.html',
        ]);
    });

    it('round-trips through readTar', () => {
        const read = readTar(archive());
        for (const file of files) {
            expect(read.find(({ path }) => path === file.path)?.bytes).toEqual(file.bytes);
        }
    });

    it('is readable by the system tar with fixed owner, modes and mtime', async () => {
        const path = join(dir, 'bundle.tar');
        await writeFile(path, archive());
        const listing = execFileSync('tar', ['-tvf', path], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
        const lines = listing.trim().split('\n');
        expect(lines.map((line) => line.split(/\s+/).at(-1))).toEqual([
            'manifest.json',
            'assets/',
            'assets/Z-upper.css',
            'assets/fonts/',
            'assets/fonts/inter-Ab12Cd34.woff2',
            'assets/index-BxD3f9_a.js',
            'index.html',
        ]);
        expect(lines.filter((line) => line.startsWith('drwxr-xr-x'))).toHaveLength(2);
        expect(lines.filter((line) => line.startsWith('-rw-r--r--'))).toHaveLength(5);
        const extracted = join(dir, 'out');
        await mkdir(extracted);
        execFileSync('tar', ['-xf', path, '-C', extracted]);
        expect(execFileSync('cat', [join(extracted, 'index.html')], { encoding: 'utf8' })).toBe('<!doctype html>');
    });

    it('writes ustar headers with uid/gid 0, empty owner names, the given mtime and no extended headers', () => {
        const header = archive().subarray(0, 512);
        const field = (offset: number, length: number): string =>
            new TextDecoder().decode(header.subarray(offset, offset + length));
        expect(field(100, 8)).toBe('0000644\0');
        expect(field(108, 16)).toBe('0000000\x000000000\0');
        expect(field(136, 12)).toBe(`${MTIME.toString(8).padStart(11, '0')}\0`);
        expect(field(156, 1)).toBe('0');
        expect(field(257, 8)).toBe('ustar\x0000');
        expect(header.subarray(265, 329).every((byte) => byte === 0)).toBe(true);
    });

    it('pads the archive to whole 10 KiB records ending in zero blocks', () => {
        const bytes = archive();
        expect(bytes.length % 10_240).toBe(0);
        expect(bytes.subarray(-1024).every((byte) => byte === 0)).toBe(true);
    });

    it('splits a path over 100 bytes into prefix and name', () => {
        const long = `assets/${'d'.repeat(90)}/${'f'.repeat(60)}.js`;
        const read = readTar(archive([...files, { path: long, bytes: text('x') }]));
        expect(read.map(({ path }) => path)).toContain(long);
        const header = archive([
            { path: 'manifest.json', bytes: text('{}') },
            { path: long, bytes: text('x') },
        ]);
        // manifest (2 blocks), then the directories `assets/` and `assets/ddd…/`, then the file's header.
        expect(new TextDecoder().decode(header.subarray(2048 + 345, 2048 + 345 + 7))).toBe('assets/');
        expect(new TextDecoder().decode(header.subarray(2048, 2048 + 4))).toBe('ffff');
    });

    it.each([
        ['a name segment over 100 bytes', `assets/${'f'.repeat(101)}`],
        ['a prefix over 155 bytes', `${'d'.repeat(160)}/x.js`],
    ])('refuses %s', (_case, path) => {
        expect(() => archive([...files, { path, bytes: text('x') }])).toThrow(TarPathError);
    });

    it.each([
        ['..', '../escape.js'],
        ['a .. segment', 'assets/../../escape.js'],
        ['a . segment', './index.js'],
        ['an absolute path', '/etc/passwd'],
        ['an empty segment', 'assets//x.js'],
        ['a trailing slash', 'assets/'],
        ['a backslash', 'assets\\x.js'],
        ['non-ASCII', 'assets/ž.js'],
        ['a space', 'assets/a b.js'],
        ['an empty path', ''],
    ])('refuses %s', (_case, path) => {
        expect(() => archive([...files, { path, bytes: text('x') }])).toThrow(TarPathError);
    });

    it('refuses duplicates, a missing first entry, a file that is also a directory and a bad mtime', () => {
        expect(() => archive([...files, { path: 'index.html', bytes: text('again') }])).toThrow(/duplicate/);
        expect(() => writeTar(files, { mtime: MTIME, first: 'missing.json' })).toThrow(/first entry/);
        expect(() => archive([...files, { path: 'assets', bytes: text('x') }])).toThrow(/file and a directory/);
        expect(() => writeTar(files, { mtime: -1, first: 'manifest.json' })).toThrow(RangeError);
        expect(() => writeTar(files, { mtime: 1.5, first: 'manifest.json' })).toThrow(RangeError);
    });
});

describe('readTree', () => {
    it('lists every regular file with /-separated paths, sorted by bytes', async () => {
        await mkdir(join(dir, 'assets', 'fonts'), { recursive: true });
        await writeFile(join(dir, 'index.html'), 'i');
        await writeFile(join(dir, 'assets', 'b.js'), 'b');
        await writeFile(join(dir, 'assets', 'C.js'), 'C');
        await writeFile(join(dir, 'assets', 'fonts', 'f.woff2'), 'f');
        const tree = await readTree(dir);
        expect(tree.map(({ path }) => path)).toEqual([
            'assets/C.js',
            'assets/b.js',
            'assets/fonts/f.woff2',
            'index.html',
        ]);
        expect(new TextDecoder().decode(tree[0]?.bytes)).toBe('C');
    });

    it('refuses a symlink, even to a file inside the tree', async () => {
        await writeFile(join(dir, 'index.html'), 'i');
        await symlink(join(dir, 'index.html'), join(dir, 'link.html'));
        await expect(readTree(dir)).rejects.toThrow(/symlink/);
    });

    it('refuses a symlinked directory', async () => {
        await mkdir(join(dir, 'real'));
        await symlink(join(dir, 'real'), join(dir, 'assets'));
        await expect(readTree(dir)).rejects.toThrow(TarPathError);
    });

    it('refuses anything that is not a file or a directory', async () => {
        execFileSync('mkfifo', [join(dir, 'pipe')]);
        await expect(readTree(dir)).rejects.toThrow(/not a regular file/);
    });

    it('refuses a file name the archive could not carry', async () => {
        await writeFile(join(dir, 'a b.js'), 'x');
        await expect(readTree(dir)).rejects.toThrow(TarPathError);
    });
});

describe('readTar', () => {
    function corrupt(change: (bytes: Uint8Array) => void, input: readonly TarFile[] = files): Uint8Array {
        const bytes = archive(input);
        change(bytes);
        return bytes;
    }
    function setField(bytes: Uint8Array, offset: number, value: string): void {
        bytes.set(new TextEncoder().encode(value), offset);
    }
    function fixChecksum(bytes: Uint8Array, at: number): void {
        bytes.set(new TextEncoder().encode(' '.repeat(8)), at + 148);
        const sum = bytes.subarray(at, at + 512).reduce((total, byte) => total + byte, 0);
        setField(bytes, at + 148, `${sum.toString(8).padStart(6, '0')}\0 `);
    }

    it('refuses a wrong header checksum', () => {
        expect(() =>
            readTar(
                corrupt((bytes) => {
                    setField(bytes, 0, 'x');
                }),
            ),
        ).toThrow(/checksum/);
    });

    it('refuses a symlink, hard link or other entry type', () => {
        for (const type of ['1', '2', '3', 'x', 'g']) {
            const bytes = corrupt((b) => {
                setField(b, 156, type);
                fixChecksum(b, 0);
            });
            expect(() => readTar(bytes)).toThrow(/not a regular file/);
        }
    });

    it('refuses a non-ustar header and a malformed number', () => {
        expect(() =>
            readTar(
                corrupt((b) => {
                    setField(b, 257, 'gnutar');
                    fixChecksum(b, 0);
                }),
            ),
        ).toThrow(/ustar/);
        expect(() =>
            readTar(
                corrupt((b) => {
                    setField(b, 124, '9');
                    fixChecksum(b, 0);
                }),
            ),
        ).toThrow(/size/);
    });

    it('refuses a path that escapes the root', () => {
        const bytes = corrupt((b) => {
            setField(b, 0, '../x.json\0\0\0\0');
            fixChecksum(b, 0);
        });
        expect(() => readTar(bytes)).toThrow(TarPathError);
    });

    it('refuses duplicate files and directories', () => {
        const single = [{ path: 'manifest.json', bytes: text('{}') }];
        const one = archive(single).subarray(0, 1024);
        const doubled = new Uint8Array(4096);
        doubled.set(one, 0);
        doubled.set(one, 1024);
        expect(() => readTar(doubled)).toThrow(/duplicate/);

        const withDirectory = archive([...single, { path: 'a/x', bytes: text('x') }]);
        const directory = withDirectory.subarray(1024, 1536);
        const twice = new Uint8Array(4096);
        twice.set(withDirectory.subarray(0, 1536), 0);
        twice.set(directory, 1536);
        expect(() => readTar(twice)).toThrow(/duplicate/);
    });

    it('refuses a directory entry with content or without a trailing slash', () => {
        const input = [
            { path: 'manifest.json', bytes: text('{}') },
            { path: 'a/x', bytes: text('x') },
        ];
        expect(() =>
            readTar(
                corrupt((b) => {
                    setField(b, 1024 + 124, '00000000001');
                    fixChecksum(b, 1024);
                }, input),
            ),
        ).toThrow(/directory/);
        expect(() =>
            readTar(
                corrupt((b) => {
                    setField(b, 1024 + 1, '\0');
                    fixChecksum(b, 1024);
                }, input),
            ),
        ).toThrow(/directory/);
    });

    it('refuses truncation and data after the end marker', () => {
        const bytes = archive();
        expect(() => readTar(bytes.subarray(0, 4000))).toThrow(/truncated file/);
        expect(() => readTar(bytes.subarray(0, 100))).toThrow(/truncated archive/);
        const trailing = bytes.slice();
        trailing[trailing.length - 1] = 1;
        expect(() => readTar(trailing)).toThrow(/after the end marker/);
        expect(() => readTar(new Uint8Array(0))).toThrow(TarFormatError);
    });

    it('refuses more entries or more bytes than the limits', () => {
        const many = Array.from({ length: TAR_LIMITS.maxEntries + 1 }, (_, index) => ({
            path: `f${String(index)}`,
            bytes: new Uint8Array(0),
        }));
        expect(() => readTar(writeTar(many, { mtime: 0, first: 'f0' }))).toThrow(/too many entries/);

        const big = archive([{ path: 'manifest.json', bytes: text('{}') }]);
        const header = big.slice(0, 512);
        setField(header, 124, `${(TAR_LIMITS.maxUnpackedBytes + 1).toString(8).padStart(11, '0')}\0`);
        fixChecksum(header, 0);
        const oversized = new Uint8Array(1024);
        oversized.set(header);
        expect(() => readTar(oversized)).toThrow(/too large/);
    });
});

describe('assertSafePath', () => {
    it('accepts the paths Vite emits', () => {
        expect(() => {
            assertSafePath('index.html');
            assertSafePath('assets/index-BxD3f9_a.js');
        }).not.toThrow();
    });
});
