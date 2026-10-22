import { describe, expect, it } from 'vitest';

import { canPreviewImage } from './safe-preview';

const clean = { status: 'clean' };

describe('canPreviewImage', () => {
    it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG'])('previews a clean %s', (type) => {
        expect(canPreviewImage({ contentType: type, scan: clean })).toBe(true);
    });

    it.each([
        'image/svg+xml',
        'text/html',
        'application/pdf',
        'text/plain',
        'application/octet-stream',
        'image/png; charset=utf-8',
        'image/avif',
        'image/x-icon',
        '',
    ])('never previews %j', (type) => {
        expect(canPreviewImage({ contentType: type, scan: clean })).toBe(false);
    });

    it.each(['pending', 'infected', 'failed', 'quarantined'])('never previews a PNG whose scan is %s', (status) => {
        expect(canPreviewImage({ contentType: 'image/png', scan: { status } })).toBe(false);
    });
});
