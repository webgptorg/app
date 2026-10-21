import { describe, expect, it } from 'vitest';

import { readTar } from './tar-reader.ts';
import type { ReadTarOptions, TarEntry } from './tar-reader.ts';
import { chunked, paxRecords, tarArchive, tarHeader } from './testing/tar-writer.ts';

const LONG_PATH = `${'nested-directory/'.repeat(8)}pax-file.txt`;
const GNU_PATH = `${'gnu-directory/'.repeat(9)}gnu-file.txt`;

const archive = tarArchive([
    { name: 'etc/', typeflag: '5' },
    { name: 'etc/hostname', content: 'relay\n' },
    { name: 'etc/empty', content: '' },
    { name: 'PaxHeaders/global', typeflag: 'g', content: paxRecords({ path: 'global/ignored', comment: 'x' }) },
    { name: 'PaxHeaders/long', typeflag: 'x', content: paxRecords({ path: LONG_PATH }) },
    { name: 'truncated-name', content: 'pax body' },
    { name: '././@LongLink', typeflag: 'L', magic: 'gnu', content: `${GNU_PATH}\0` },
    { name: 'gnu-truncated', magic: 'gnu', content: 'gnu body' },
    { name: 'file.bin', prefix: 'usr/share', content: new Uint8Array(1000).fill(7) },
    { name: 'base256.bin', base256Size: true, content: 'sized in base 256' },
    { name: 'etc/localtime', typeflag: '2', linkname: '/usr/share/zoneinfo/UTC' },
    { name: 'etc/hard', typeflag: '1', linkname: 'etc/hostname' },
    { name: 'dev/null', typeflag: '3' },
]);

async function entries(bytes: Uint8Array, chunkSize = 4096, options?: ReadTarOptions): Promise<TarEntry[]> {
    const out: TarEntry[] = [];
    for await (const entry of readTar(chunked(bytes, chunkSize), options)) out.push(entry);
    return out;
}

function summary(list: readonly TarEntry[]): readonly (readonly [string, string, string])[] {
    return list.map((entry) => [entry.path, entry.type, Buffer.from(entry.content).toString('latin1')]);
}

describe('readTar', () => {
    it('reads ustar, PAX, GNU long names, prefixes, base-256 sizes and every entry type', async () => {
        expect(summary(await entries(archive))).toEqual([
            ['etc/', 'directory', ''],
            ['etc/hostname', 'file', 'relay\n'],
            ['etc/empty', 'file', ''],
            [LONG_PATH, 'file', 'pax body'],
            [GNU_PATH, 'file', 'gnu body'],
            ['usr/share/file.bin', 'file', '\x07'.repeat(1000)],
            ['base256.bin', 'file', 'sized in base 256'],
            ['etc/localtime', 'symlink', ''],
            ['etc/hard', 'hardlink', ''],
            ['dev/null', 'other', ''],
        ]);
    });

    it.each([1, 7, 511, 513])('gives the same entries for %i-byte chunks', async (size) => {
        expect(summary(await entries(archive, size))).toEqual(summary(await entries(archive)));
    });

    it('applies a PAX size override', async () => {
        const content = 'twelve bytes';
        const bytes = Buffer.concat([
            tarArchive([{ name: 'PaxHeaders/x', typeflag: 'x', content: paxRecords({ size: '12' }) }]).subarray(
                0,
                1024,
            ),
            tarHeader({ name: 'big' }, 0),
            Buffer.from(content.padEnd(512, '\0')),
            Buffer.alloc(1024),
        ]);
        expect(summary(await entries(bytes))).toEqual([['big', 'file', content]]);
    });

    it('refuses a truncated archive, wherever it is cut', async () => {
        for (const end of [100, 512 + 3, archive.length - 1024, archive.length - 512]) {
            await expect(entries(archive.subarray(0, end))).rejects.toThrow('truncated archive');
        }
    });

    it('refuses a header checksum mismatch', async () => {
        const corrupt = Buffer.from(archive);
        corrupt[512 + 10] = 0x41;
        await expect(entries(corrupt)).rejects.toThrow('checksum mismatch');
    });

    it('refuses a file over the cap', async () => {
        await expect(entries(archive, 4096, { maxFileBytes: 999 })).rejects.toThrow('usr/share/file.bin');
    });

    it('refuses data of a type it cannot scan', async () => {
        await expect(entries(tarArchive([{ name: 'sparse', typeflag: 'S', content: 'data' }]))).rejects.toThrow(
            'unsupported entry type',
        );
    });

    it('closes the source when the consumer stops early', async () => {
        let closed = false;
        async function* source(): AsyncGenerator<Uint8Array> {
            try {
                yield* chunked(archive, 512);
            } finally {
                closed = true;
            }
        }
        for await (const entry of readTar(source())) {
            expect(entry.path).toBe('etc/');
            break;
        }
        expect(closed).toBe(true);
    });
});
