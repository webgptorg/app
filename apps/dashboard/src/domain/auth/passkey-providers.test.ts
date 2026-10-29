import { describe, expect, it } from 'vitest';

import { normalizeAaguid, passkeyProviderName } from './passkey-providers';

describe('passkey providers', () => {
    it('keeps a UUID AAGUID in lowercase', () => {
        expect(normalizeAaguid('EA9B8D66-4D01-1D21-3CE4-B6B48CB575D4')).toBe('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4');
    });

    it('drops the anonymous all-zero AAGUID and anything that is not a UUID', () => {
        expect(normalizeAaguid('00000000-0000-0000-0000-000000000000')).toBeNull();
        expect(normalizeAaguid('')).toBeNull();
        expect(normalizeAaguid('ea9b8d664d011d213ce4b6b48cb575d4')).toBeNull();
        expect(normalizeAaguid('<script>-0000-0000-0000-000000000000')).toBeNull();
    });

    it('names known providers and nothing else', () => {
        expect(passkeyProviderName('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4')).toBe('Google Password Manager');
        expect(passkeyProviderName('08987058-cadc-4b81-b6e1-30de50dcbe96')).toBe('Windows Hello');
        expect(passkeyProviderName('12345678-1234-1234-1234-123456789abc')).toBeNull();
        expect(passkeyProviderName(null)).toBeNull();
        expect(passkeyProviderName('constructor')).toBeNull();
    });
});
