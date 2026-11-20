import type { LiveMediaKind } from '@ptbk/engine-api';

import type { FrameDrawer } from './live-session';

const MEDIA_TYPES: Readonly<Record<LiveMediaKind, string>> = {
    'tab-frame-jpeg': 'image/jpeg',
    'tab-frame-png': 'image/png',
    'tab-frame-webp': 'image/webp',
};

export type DecodeImage = (image: Blob) => Promise<ImageBitmap>;

/**
 * Draws frames onto a `<canvas>` with `createImageBitmap`: the image is decoded from memory, never loaded from a URL,
 * so the engine CSP needs no `blob:` in `img-src` and nothing reaches the DOM but pixels. The canvas takes each
 * frame's own size; its CSS scales it to the page, keeping the tab's aspect ratio.
 */
export function createCanvasDrawer(
    canvas: HTMLCanvasElement,
    decode: DecodeImage = (image) => createImageBitmap(image),
): FrameDrawer {
    return {
        draw: async (media) => {
            const bitmap = await decode(new Blob([media.payload.slice()], { type: MEDIA_TYPES[media.kind] }));
            try {
                if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
                if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
                canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
            } finally {
                bitmap.close();
            }
        },
        clear: () => {
            canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        },
    };
}
