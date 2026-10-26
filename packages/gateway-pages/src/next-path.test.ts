import { describe, expect, it } from 'vitest';

import { isSafeNextPath } from './index';

describe('isSafeNextPath', () => {
    it.each([
        '/',
        '/agents',
        '/agents/42?tab=runs#latest',
        '/chats/%2F',
        '/a:b',
        '/setting',
        '/authors',
        `/${'a'.repeat(2047)}`,
    ])('accepts the same-origin path %j', (path) => {
        expect(isSafeNextPath(path)).toBe(true);
    });

    it.each([
        ['empty', ''],
        ['relative', 'agents'],
        ['protocol-relative', '//evil.example'],
        ['backslash', '/\\evil.example'],
        ['backslash later', '/a\\b'],
        ['absolute URL', 'https://evil.example/'],
        ['scheme', 'javascript:alert(1)'],
        ['tab', '/\t/evil.example'],
        ['newline', '/a\nb'],
        ['NUL', '/a\u0000'],
        ['DEL', '/a\u007f'],
        ['too long', `/${'a'.repeat(2048)}`],
        ['sign-in loop', '/auth/sign-in'],
        ['step-up loop', '/auth/step-up?returnTo=/'],
        ['gateway root', '/auth'],
        ['setup', '/setup'],
        ['setup with a fragment', '/setup#secret'],
        ['dot segments into the gateway', '/agents/../auth/sign-in'],
        ['encoded dot segments into the gateway', '/x/%2e%2e/auth/sign-in'],
        ['engine API', '/api/v1/me'],
        ['well-known', '/.well-known/security.txt'],
    ])('refuses %s', (_name, path) => {
        expect(isSafeNextPath(path)).toBe(false);
    });

    it('refuses a non-string from untyped callers', () => {
        expect(isSafeNextPath(42 as unknown as string)).toBe(false);
    });
});
