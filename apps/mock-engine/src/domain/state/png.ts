import type { SeededSequence } from './seed-random';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    const typed = out.subarray(4, 8 + data.length);
    typed.set(new TextEncoder().encode(type));
    typed.set(data, 4);
    view.setUint32(8 + data.length, crc32(typed));
    return out;
}

/** zlib (RFC 1950), which is what PNG's IDAT holds and what the Compression Streams `deflate` format produces. */
async function zlib(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A small, valid RGB PNG whose picture (a few overlapping soft shapes, like a chart thumbnail) comes from `sequence`,
 * so the same seed gives the same bytes. Truecolour, 8 bits, no interlace.
 */
export async function generatePng(sequence: SeededSequence, size = 64): Promise<Uint8Array<ArrayBuffer>> {
    const background = [sequence.int(200, 255), sequence.int(200, 255), sequence.int(200, 255)] as const;
    const shapes = Array.from({ length: sequence.int(2, 4) }, () => ({
        x: sequence.int(0, size - 1),
        y: sequence.int(0, size - 1),
        radius: sequence.int(size / 8, size / 2),
        colour: [sequence.int(0, 200), sequence.int(0, 200), sequence.int(0, 200)] as const,
    }));
    const rows = new Uint8Array(size * (1 + size * 3));
    for (let y = 0; y < size; y++) {
        const row = y * (1 + size * 3);
        // Filter type 0 (none) for every row.
        rows[row] = 0;
        for (let x = 0; x < size; x++) {
            let pixel: readonly number[] = background;
            for (const shape of shapes) {
                if ((x - shape.x) ** 2 + (y - shape.y) ** 2 <= shape.radius ** 2) pixel = shape.colour;
            }
            rows.set(pixel, row + 1 + x * 3);
        }
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, size);
    view.setUint32(4, size);
    header.set([8, 2, 0, 0, 0], 8);
    const parts = [
        new Uint8Array(SIGNATURE),
        chunk('IHDR', header),
        chunk('IDAT', await zlib(rows)),
        chunk('IEND', new Uint8Array()),
    ];
    const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        png.set(part, offset);
        offset += part.length;
    }
    return png;
}
