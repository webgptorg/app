/**
 * The fake browser's screencast: small palette PNGs drawn from the tab's state, so a viewer shows something that
 * moves and answers input without a real browser. Pure and portable (no zlib): the image data goes in stored deflate
 * blocks, which a 256 × 160 palette image keeps well under `MAX_LIVE_MEDIA_BYTES`.
 */

export const FAKE_FRAME_WIDTH = 256;
export const FAKE_FRAME_HEIGHT = 160;

export interface FakeFrameInput {
    /** Picks the page's colour, so another origin looks different. */
    readonly origin: string;
    /** Advances the progress bar, so frames visibly follow each other. */
    readonly tick: number;
    /** Where the last pointer event was, in frame pixels. */
    readonly pointer: { readonly x: number; readonly y: number } | null;
    /** How many characters were typed: one block each, never the characters themselves. */
    readonly typed: number;
}

const PALETTE = [
    [0xf4, 0xf4, 0xf5],
    [0x1f, 0x29, 0x37],
    [0x63, 0x66, 0xf1],
    [0x10, 0xb9, 0x81],
    [0xf5, 0x9e, 0x0b],
    [0xef, 0x44, 0x44],
    [0x0e, 0xa5, 0xe9],
    [0xa8, 0x55, 0xf7],
] as const;
const PAGE_COLOURS = [2, 3, 4, 6, 7] as const;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
    let a = 1;
    let b = 0;
    for (const byte of bytes) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

function u32(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0);
    return bytes;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const typed = concat([new TextEncoder().encode(type), data]);
    return concat([u32(data.byteLength), typed, u32(crc32(typed))]);
}

/** A zlib stream of stored (uncompressed) deflate blocks. */
function storedZlib(data: Uint8Array): Uint8Array {
    const blocks: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
    const max = 0xffff;
    for (let offset = 0; offset < data.byteLength || offset === 0; offset += max) {
        const block = data.subarray(offset, offset + max);
        const final = offset + max >= data.byteLength ? 1 : 0;
        const header = new Uint8Array(5);
        header[0] = final;
        new DataView(header.buffer).setUint16(1, block.byteLength, true);
        new DataView(header.buffer).setUint16(3, ~block.byteLength & 0xffff, true);
        blocks.push(header, block);
        if (final) break;
    }
    blocks.push(u32(adler32(data)));
    return concat(blocks);
}

function hash(text: string): number {
    let value = 0;
    for (let index = 0; index < text.length; index++) value = (value * 31 + text.charCodeAt(index)) >>> 0;
    return value;
}

export function renderFakeFrame(input: FakeFrameInput): Uint8Array {
    const width = FAKE_FRAME_WIDTH;
    const height = FAKE_FRAME_HEIGHT;
    const page = PAGE_COLOURS[hash(input.origin) % PAGE_COLOURS.length] ?? 2;
    const pixels = new Uint8Array(width * height).fill(0);
    const fill = (x0: number, y0: number, w: number, h: number, colour: number): void => {
        for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
            pixels.fill(colour, y * width + Math.max(0, x0), y * width + Math.min(width, x0 + w));
        }
    };
    fill(0, 0, width, 18, page);
    fill(16, 36, 140, 10, 1);
    fill(16, 56, 224, 6, 1);
    fill(16, 70, 200, 6, 1);
    fill(16, 96, 120, 16, page);
    fill(0, height - 4, ((input.tick % 32) + 1) * (width / 32), 4, 5);
    for (let index = 0; index < Math.min(input.typed, 24); index++) fill(144 + index * 4, 100, 3, 8, 1);
    if (input.pointer !== null) {
        const x = Math.round(input.pointer.x);
        const y = Math.round(input.pointer.y);
        fill(x - 4, y, 9, 1, 5);
        fill(x, y - 4, 1, 9, 5);
    }
    const raw = new Uint8Array((width + 1) * height);
    for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header.set([8, 3, 0, 0, 0], 8);
    return concat([
        Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
        chunk('IHDR', header),
        chunk('PLTE', Uint8Array.from(PALETTE.flat())),
        chunk('IDAT', storedZlib(raw)),
        chunk('IEND', new Uint8Array(0)),
    ]);
}
