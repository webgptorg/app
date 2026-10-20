import { describe, expect, it } from 'vitest';

import { safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
    it.each([
        ['/account', '/account'],
        ['/account?tab=passkeys', '/account?tab=passkeys'],
        ['/account#secret-token', '/account'],
        ['/a/../account', '/account'],
        ['/', '/'],
        ['/signin-help', '/signin-help'],
    ])('keeps the same-origin path %s as %s', (value, expected) => {
        expect(safeReturnTo(value)).toBe(expected);
    });

    it.each([
        ['protocol-relative', '//evil.example/account'],
        ['backslash', '/\\evil.example'],
        ['absolute', 'https://evil.example/account'],
        ['relative', 'account'],
        ['sign-in', '/signin'],
        ['sign-up', '/signup?x=1'],
        ['recovery', '/recover'],
        ['below an auth path', '/recover/x'],
        ['too long', `/${'a'.repeat(2048)}`],
        ['a number', 42],
        ['missing', undefined],
    ])('refuses a %s value', (_label, value) => {
        expect(safeReturnTo(value)).toBeUndefined();
    });
});
