import { describe, expect, it } from 'vitest';

import { generatePng } from './png';
import { createSeededSequence } from './seed-random';

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Splits a PNG into its chunks, checking each CRC the way a decoder would. */
function chunks(png: Uint8Array): { type: string; data: Uint8Array<ArrayBuffer> }[] {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const table = Array.from({ length: 256 }, (_, index) => {
        let crc = index;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
        return crc >>> 0;
    });
    const found: { type: string; data: Uint8Array<ArrayBuffer> }[] = [];
    for (let offset = 8; offset < png.length;) {
        const length = view.getUint32(offset);
        const typed = png.slice(offset + 4, offset + 8 + length);
        let crc = 0xffffffff;
        for (const byte of typed) crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
        expect((crc ^ 0xffffffff) >>> 0).toBe(view.getUint32(offset + 8 + length));
        found.push({ type: new TextDecoder().decode(typed.subarray(0, 4)), data: typed.slice(4) });
        offset += 12 + length;
    }
    return found;
}

describe('generatePng', () => {
    it('writes a valid 64 × 64 truecolour PNG', async () => {
        const png = await generatePng(createSeededSequence(7));
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const parts = chunks(png);
        expect(parts.map(({ type }) => type)).toEqual(['IHDR', 'IDAT', 'IEND']);
        const header = new DataView(parts[0]?.data.buffer ?? new ArrayBuffer(13));
        expect([header.getUint32(0), header.getUint32(4), header.getUint8(8), header.getUint8(9)]).toEqual([
            64, 64, 8, 2,
        ]);
        const pixels = await inflate(parts[1]?.data ?? new Uint8Array());
        expect(pixels.length).toBe(64 * (1 + 64 * 3));
        expect(png.length).toBeLessThan(4096);
    });

    it('gives the same bytes for the same sequence and different ones for another', async () => {
        const once = await generatePng(createSeededSequence(1));
        expect(await generatePng(createSeededSequence(1))).toEqual(once);
        expect(await generatePng(createSeededSequence(2))).not.toEqual(once);
    });
});
