import { zstdCompressSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { writeArchiveTar, zstdStore } from '../../src/suites/ui-loader/archive';
import { readFirstEntry } from './archive';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readFirstEntry', () => {
    it('reads the first file of a compressed ustar archive', () => {
        const tar = writeArchiveTar([
            { kind: 'file', path: 'manifest.json', bytes: bytes('{"v":1}') },
            { kind: 'file', path: 'index.html', bytes: bytes('<p>') },
        ]);
        const entry = readFirstEntry(zstdCompressSync(tar));
        expect(entry.kind === 'entry' && [entry.path, new TextDecoder().decode(entry.bytes)]).toEqual([
            'manifest.json',
            '{"v":1}',
        ]);
    });

    it('joins the ustar prefix to the name', () => {
        const tar = writeArchiveTar([{ kind: 'file', path: 'manifest.json', bytes: bytes('{}') }]);
        tar.set(bytes('ui'), 345);
        const entry = readFirstEntry(zstdStore(tar));
        expect(entry.kind === 'entry' && entry.path).toBe('ui/manifest.json');
    });

    it.each([
        ['not zstd', bytes('plain text'), 'not a zstd frame'],
        ['a short tar', zstdStore(new Uint8Array(100)), 'the tar archive is truncated'],
        ['not ustar', zstdStore(new Uint8Array(1024)), 'not a ustar archive'],
        [
            'a directory first',
            zstdStore(writeArchiveTar([{ kind: 'directory', path: 'ui' }])),
            'the first entry is not a regular file',
        ],
        [
            'a truncated entry',
            zstdStore(
                writeArchiveTar([{ kind: 'file', path: 'manifest.json', bytes: new Uint8Array(2048) }]).subarray(
                    0,
                    1024,
                ),
            ),
            'the first entry is truncated',
        ],
    ])('refuses %s', (_name, archive, reason) => {
        expect(readFirstEntry(archive)).toEqual({ kind: 'invalid', reason });
    });
});
