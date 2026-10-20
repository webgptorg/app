import { describe, expect, it } from 'vitest';

import { safeImageSource, safeNextPath } from './safe-url';

const origin = 'https://engine.example';

describe('safeNextPath', () => {
    it.each([
        ['/', '/'],
        ['/agents', '/agents'],
        ['/agents/a1?tab=chat#m3', '/agents/a1?tab=chat#m3'],
        ['/agents/../agents', '/agents'],
    ])('keeps the same-origin path %s', (value, expected) => {
        expect(safeNextPath(value, origin)).toBe(expected);
    });

    it.each([
        ['an absolute URL', 'https://evil.example/'],
        ['a protocol-relative URL', '//evil.example/'],
        ['a backslash form', '/\\evil.example/'],
        ['a tab-split protocol-relative URL', '/\t/evil.example/'],
        ['a javascript: URL', 'javascript:alert(1)'],
        ['a relative path', 'agents'],
        ['the sign-in page', '/auth/sign-in'],
        ['an API path', '/api/v1/agents'],
        ['the setup page', '/setup'],
        ['a well-known path', '/.well-known/security.txt'],
        ['an empty string', ''],
    ])('refuses %s', (_, value) => {
        expect(safeNextPath(value, origin)).toBeNull();
    });

    it('refuses everything when the origin is opaque', () => {
        expect(safeNextPath('/agents', 'null')).toBeNull();
    });
});

describe('safeImageSource', () => {
    it.each(['/files/avatar.png', 'data:image/png;base64,iVBORw0KGgo='])('keeps %s, which the CSP allows', (value) => {
        expect(safeImageSource(value)).toBe(value);
    });

    it.each([
        'https://attacker.example/pixel.png',
        '//attacker.example/pixel.png',
        '/\\attacker.example/pixel.png',
        'javascript:alert(1)',
        'data:text/html;base64,PHNjcmlwdD4=',
        'data:image/svg+xml;base64,PHN2Zz4=',
        'avatar.png',
    ])('refuses %s', (value) => {
        expect(safeImageSource(value)).toBeNull();
    });
});
