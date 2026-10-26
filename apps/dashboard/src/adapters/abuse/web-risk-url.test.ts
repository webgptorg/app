import { describe, expect, it } from 'vitest';

import { canonicalizeUrl, expressionHash, lookupExpressions } from './web-risk-url';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Verbatim from Web Risk's "URLs and hashing", Canonicalization. */
const CANONICALIZATION: readonly (readonly [string, string])[] = [
    ['http://host/%25%32%35', 'http://host/%25'],
    ['http://host/%25%32%35%25%32%35', 'http://host/%25%25'],
    ['http://host/%2525252525252525', 'http://host/%25'],
    ['http://host/asdf%25%32%35asd', 'http://host/asdf%25asd'],
    ['http://host/%%%25%32%35asd%%', 'http://host/%25%25%25asd%25%25'],
    ['http://www.google.com/', 'http://www.google.com/'],
    [
        'http://%31%36%38%2e%31%38%38%2e%39%39%2e%32%36/%2E%73%65%63%75%72%65/%77%77%77%2E%65%62%61%79%2E%63%6F%6D/',
        'http://168.188.99.26/.secure/www.ebay.com/',
    ],
    [
        'http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/',
        'http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/',
    ],
    [
        'http://host%23.com/%257Ea%2521b%2540c%2523d%2524e%25f%255E00%252611%252A22%252833%252944_55%252B',
        'http://host%23.com/~a!b@c%23d$e%25f^00&11*22(33)44_55+',
    ],
    ['http://3279880203/blah', 'http://195.127.0.11/blah'],
    ['http://www.google.com/blah/..', 'http://www.google.com/'],
    ['www.google.com/', 'http://www.google.com/'],
    ['www.google.com', 'http://www.google.com/'],
    ['http://www.evil.com/blah#frag', 'http://www.evil.com/blah'],
    ['http://www.GOOgle.com/', 'http://www.google.com/'],
    ['http://www.google.com.../', 'http://www.google.com/'],
    ['http://www.google.com/foo\tbar\rbaz\n2', 'http://www.google.com/foobarbaz2'],
    ['http://www.google.com/q?', 'http://www.google.com/q?'],
    ['http://www.google.com/q?r?', 'http://www.google.com/q?r?'],
    ['http://www.google.com/q?r?s', 'http://www.google.com/q?r?s'],
    ['http://evil.com/foo#bar#baz', 'http://evil.com/foo'],
    ['http://evil.com/foo;', 'http://evil.com/foo;'],
    ['http://evil.com/foo?bar;', 'http://evil.com/foo?bar;'],
    ['http://notrailingslash.com', 'http://notrailingslash.com/'],
    ['http://www.gotaport.com:1234/', 'http://www.gotaport.com/'],
    ['  http://www.google.com/  ', 'http://www.google.com/'],
    ['http:// leadingspace.com/', 'http://%20leadingspace.com/'],
    ['http://%20leadingspace.com/', 'http://%20leadingspace.com/'],
    ['%20leadingspace.com/', 'http://%20leadingspace.com/'],
    ['https://www.securesite.com/', 'https://www.securesite.com/'],
    ['http://host.com/ab%23cd', 'http://host.com/ab%23cd'],
    ['http://host.com//twoslashes?more//slashes', 'http://host.com/twoslashes?more//slashes'],
];

describe('canonicalizeUrl', () => {
    it.each(CANONICALIZATION)('canonicalizes %j as Web Risk does', (input, expected) => {
        expect(canonicalizeUrl(input)?.url).toBe(expected);
    });

    it('takes bytes, as the documented example with raw \\x01 and \\x80 does', () => {
        expect(
            canonicalizeUrl(Uint8Array.from([...Buffer.from('http://'), 0x01, 0x80, ...Buffer.from('.com/')]))?.url,
        ).toBe('http://%01%80.com/');
        expect(canonicalizeUrl('http://é.com/')?.url).toBe('http://%C3%A9.com/');
    });

    it('drops user info, lowercases the scheme, and reads every IPv4 form', () => {
        expect(canonicalizeUrl('HTTP://user:pw@Host.example/')?.url).toBe('http://host.example/');
        expect(canonicalizeUrl('http://0x7f.1/')?.host).toBe('127.0.0.1');
        expect(canonicalizeUrl('http://017.0.0x10.1/')?.host).toBe('15.0.16.1');
        expect(canonicalizeUrl('http://10.0.258/')?.host).toBe('10.0.1.2');
        expect(canonicalizeUrl('http://0x.0/')?.host).toBe('0.0.0.0');
        expect(canonicalizeUrl('http://256.1.1.1/')?.host).toBe('256.1.1.1');
        expect(canonicalizeUrl('http://1.2.3.4.5/')?.host).toBe('1.2.3.4.5');
        expect(canonicalizeUrl('http://08.1.1.1/')?.host).toBe('08.1.1.1');
        expect(canonicalizeUrl('http://1.16777216/')?.host).toBe('1.16777216');
    });

    it('refuses a URL without a host', () => {
        expect(canonicalizeUrl('http:///path')).toBeNull();
        expect(canonicalizeUrl('')).toBeNull();
        expect(canonicalizeUrl('http://.../')).toBeNull();
    });

    it('keeps a scheme-like prefix that is not followed by // as part of the host', () => {
        expect(canonicalizeUrl('localhost:8080/x')?.url).toBe('http://localhost/x');
    });
});

describe('lookupExpressions', () => {
    const expressions = (url: string) => {
        const canonical = canonicalizeUrl(url);
        if (canonical === null) throw new Error(url);
        return lookupExpressions(canonical);
    };

    it.each([
        [
            'http://a.b.c/1/2.html?param=1',
            [
                'a.b.c/1/2.html?param=1',
                'a.b.c/1/2.html',
                'a.b.c/',
                'a.b.c/1/',
                'b.c/1/2.html?param=1',
                'b.c/1/2.html',
                'b.c/',
                'b.c/1/',
            ],
        ],
        [
            'http://a.b.c.d.e.f.g/1.html',
            [
                'a.b.c.d.e.f.g/1.html',
                'a.b.c.d.e.f.g/',
                'c.d.e.f.g/1.html',
                'c.d.e.f.g/',
                'd.e.f.g/1.html',
                'd.e.f.g/',
                'e.f.g/1.html',
                'e.f.g/',
                'f.g/1.html',
                'f.g/',
            ],
        ],
        ['http://1.2.3.4/1/', ['1.2.3.4/1/', '1.2.3.4/']],
    ])('gives the documented expressions for %s', (url, expected) => {
        expect(new Set(expressions(url))).toEqual(new Set(expected));
        expect(expressions(url)).toHaveLength(expected.length);
    });

    it('stops at four root paths and 30 expressions, and gives an engine hostname three', () => {
        const deep = expressions('http://a.b.c.d.e.f/1/2/3/4/5.html?q');
        expect(deep).toHaveLength(30);
        expect(deep).toContain('b.c.d.e.f/1/2/3/');
        expect(deep).not.toContain('b.c.d.e.f/1/2/3/4/');
        expect(expressions('http://k3v6xq2mfz4pd7h5wn2rbtcayu.engines.ptbk.io/')).toEqual([
            'k3v6xq2mfz4pd7h5wn2rbtcayu.engines.ptbk.io/',
            'engines.ptbk.io/',
            'ptbk.io/',
        ]);
    });
});

describe('expressionHash', () => {
    it('is SHA-256, matching the documented FIPS 180-2 examples and their prefixes', async () => {
        expect(hex(await expressionHash('abc'))).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
        expect(hex(await expressionHash('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
            '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
        );
        expect(hex((await expressionHash('a'.repeat(1_000_000))).subarray(0, 12))).toBe('cdc76e5c9914fb9281a1c7e2');
    });
});
