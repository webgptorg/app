import { describe, expect, it } from 'vitest';

import { safeImageSource, safeLinkUrl, safeNextPath } from './safe-url';

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

describe('safeLinkUrl', () => {
    it.each([
        ['https://example.com/a', 'https://example.com/a'],
        ['http://example.com', 'http://example.com/'],
        ['HTTPS://Example.COM/Path?q=1#h', 'https://example.com/Path?q=1#h'],
        [' https://example.com/a ', 'https://example.com/a'],
        ['https://engine.example.evil.com/', 'https://engine.example.evil.com/'],
        ['https://engine.example:8443/', 'https://engine.example:8443/'],
    ])('links %s', (href, expected) => {
        expect(safeLinkUrl(href, origin)).toBe(expected);
    });

    it.each([
        ['javascript:', 'javascript:alert(1)'],
        ['mixed-case javascript:', 'JaVaScRiPt:alert(1)'],
        ['javascript: after a space', ' javascript:alert(1)'],
        ['javascript: split by a tab', 'java\tscript:alert(1)'],
        ['javascript: split by a newline', 'java\nscript:alert(1)'],
        ['data:', 'data:text/html,<script>alert(1)</script>'],
        ['vbscript:', 'vbscript:msgbox(1)'],
        ['blob:', 'blob:https://example.com/0b1c'],
        ['file:', 'file:///etc/passwd'],
        ['mailto:', 'mailto:someone@example.com'],
        ['an API path', '/v1/agents/1'],
        ['a relative path', 'agents/1'],
        ['a fragment', '#top'],
        ['a protocol-relative URL to this origin', '//engine.example/x'],
        ['a protocol-relative URL elsewhere', '//evil.example/x'],
        ['this origin', 'https://engine.example/agents'],
        ['credentials that disguise the host', 'https://engine.example@evil.example/'],
        ['a password', 'https://user:secret@example.com/'],
        ['a scheme without a host', 'https:example.com'],
        ['an unparsable URL', 'https://exa mple.com/'],
        ['an empty string', ''],
    ])('refuses %s', (_, href) => {
        expect(safeLinkUrl(href, origin)).toBeNull();
    });
});
