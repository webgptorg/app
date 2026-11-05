import { describe, expect, it } from 'vitest';

import { siteName, toWalletOrigin } from './wallet-origin';

describe('toWalletOrigin', () => {
    it('assumes https and keeps only the origin', () => {
        expect(toWalletOrigin(' github.com/login ')).toBe('https://github.com');
        expect(toWalletOrigin('http://intranet.example:8080/x')).toBe('http://intranet.example:8080');
        expect(toWalletOrigin('GitHub.com')).toBe('https://github.com');
    });

    it('refuses what is not an http(s) website', () => {
        expect(toWalletOrigin('')).toBeNull();
        expect(toWalletOrigin('javascript://alert(1)')).toBeNull();
        expect(toWalletOrigin('ftp://files.example')).toBeNull();
        expect(toWalletOrigin('not a site')).toBeNull();
    });

    it('names a site by its host without www', () => {
        expect(siteName('https://www.linkedin.com')).toBe('linkedin.com');
        expect(siteName('garbage')).toBe('garbage');
    });
});
