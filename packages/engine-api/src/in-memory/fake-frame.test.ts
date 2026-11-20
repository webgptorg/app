import { describe, expect, it } from 'vitest';

import { LIVE_MEDIA_HEADER_BYTES, MAX_LIVE_MEDIA_BYTES } from '../capabilities/live-channel';
import { FAKE_FRAME_HEIGHT, FAKE_FRAME_WIDTH, renderFakeFrame } from './fake-frame';

function chunks(png: Uint8Array): Map<string, Uint8Array> {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const found = new Map<string, Uint8Array>();
    for (let offset = 8; offset < png.byteLength;) {
        const length = view.getUint32(offset);
        const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
        found.set(type, png.subarray(offset + 8, offset + 8 + length));
        offset += 12 + length;
    }
    return found;
}

async function inflate(zlib: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([zlib.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('renderFakeFrame', () => {
    it('draws a palette PNG that decodes and fits one media message', async () => {
        const png = renderFakeFrame({ origin: 'https://shop.example', tick: 3, pointer: { x: 0, y: 159 }, typed: 40 });
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(png.byteLength + LIVE_MEDIA_HEADER_BYTES).toBeLessThanOrEqual(MAX_LIVE_MEDIA_BYTES);
        const parts = chunks(png);
        const header = new DataView((parts.get('IHDR') ?? new Uint8Array(13)).slice().buffer);
        expect([header.getUint32(0), header.getUint32(4)]).toEqual([FAKE_FRAME_WIDTH, FAKE_FRAME_HEIGHT]);
        const raw = await inflate(parts.get('IDAT') ?? new Uint8Array());
        expect(raw.byteLength).toBe((FAKE_FRAME_WIDTH + 1) * FAKE_FRAME_HEIGHT);
        expect([...parts.keys()]).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    });

    it('changes with the origin, the tick and the pointer, and never draws typed characters', () => {
        const base = { origin: 'https://a.example', tick: 1, pointer: null, typed: 0 };
        const frame = renderFakeFrame(base);
        expect(renderFakeFrame(base)).toEqual(frame);
        expect(renderFakeFrame({ ...base, origin: 'https://b.example' })).not.toEqual(frame);
        expect(renderFakeFrame({ ...base, tick: 2 })).not.toEqual(frame);
        expect(renderFakeFrame({ ...base, pointer: { x: 10, y: 10 } })).not.toEqual(frame);
        expect(renderFakeFrame({ ...base, typed: 3 })).not.toEqual(frame);
    });
});
