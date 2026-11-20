import { describe, expect, it, vi } from 'vitest';

import { createCanvasDrawer } from './canvas-drawer';

function fakeCanvas() {
    const context = { drawImage: vi.fn(), clearRect: vi.fn() };
    const canvas = { width: 1280, height: 800, getContext: vi.fn(() => context) };
    return { canvas: canvas as unknown as HTMLCanvasElement, context };
}

describe('drawing frames on a canvas', () => {
    it('decodes from memory, takes the frame’s size and frees the bitmap', async () => {
        const { canvas, context } = fakeCanvas();
        const bitmap = { width: 256, height: 160, close: vi.fn() };
        const decode = vi.fn((image: Blob) => {
            expect(image.type).toBe('image/png');
            return Promise.resolve(bitmap as unknown as ImageBitmap);
        });
        const drawer = createCanvasDrawer(canvas, decode);
        await drawer.draw({ kind: 'tab-frame-png', seq: 1, timestamp: 0, payload: new Uint8Array([1, 2, 3]) });
        expect(canvas.width).toBe(256);
        expect(canvas.height).toBe(160);
        expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
        expect(bitmap.close).toHaveBeenCalledOnce();
        drawer.clear();
        expect(context.clearRect).toHaveBeenCalledWith(0, 0, 256, 160);
    });

    it('frees the bitmap even when drawing fails', async () => {
        const { canvas, context } = fakeCanvas();
        context.drawImage.mockImplementation(() => {
            throw new Error('lost context');
        });
        const bitmap = { width: 1280, height: 800, close: vi.fn() };
        const drawer = createCanvasDrawer(canvas, () => Promise.resolve(bitmap as unknown as ImageBitmap));
        await expect(
            drawer.draw({ kind: 'tab-frame-jpeg', seq: 1, timestamp: 0, payload: new Uint8Array([1]) }),
        ).rejects.toThrow('lost context');
        expect(bitmap.close).toHaveBeenCalledOnce();
    });
});
