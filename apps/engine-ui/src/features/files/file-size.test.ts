import { createFormatters } from '@ptbk/ui';
import { describe, expect, it } from 'vitest';

import { formatBytes } from './file-size';

// Intl separates a number from its unit with a no-break space in some locales.
const plain = (text: string) => text.replaceAll(' ', ' ');

describe('formatBytes', () => {
    it('spells bytes out with English plurals', () => {
        const en = createFormatters('en');
        expect(plain(formatBytes(en, 1))).toBe('1 byte');
        expect(plain(formatBytes(en, 58))).toBe('58 bytes');
        expect(plain(formatBytes(en, 999))).toBe('999 bytes');
    });

    it('spells bytes out with Czech plurals', () => {
        const cs = createFormatters('cs');
        expect(plain(formatBytes(cs, 1))).toBe('1 bajt');
        expect(plain(formatBytes(cs, 3))).toBe('3 bajty');
        expect(plain(formatBytes(cs, 58))).toBe('58 bajtů');
    });

    it('shortens larger sizes to decimal units with one decimal', () => {
        expect(plain(formatBytes(createFormatters('en'), 1500))).toBe('1.5 kB');
        expect(plain(formatBytes(createFormatters('cs'), 1500))).toBe('1,5 kB');
        expect(plain(formatBytes(createFormatters('en'), 25_000_000))).toBe('25 MB');
        expect(plain(formatBytes(createFormatters('en'), 3_000_000_000_000))).toBe('3,000 GB');
    });
});
