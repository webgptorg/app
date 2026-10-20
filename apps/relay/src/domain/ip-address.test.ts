import { describe, expect, it } from 'vitest';

import { ipLimitKey, parseIpAddress } from './ip-address';

const bytesOf = (text: string): number[] | null => {
    const address = parseIpAddress(text);
    return address === null ? null : [...address.bytes];
};

describe('parseIpAddress', () => {
    it('parses IPv4', () => {
        expect(parseIpAddress('203.0.113.9')).toEqual({ family: 4, bytes: Uint8Array.of(203, 0, 113, 9) });
        expect(bytesOf('0.0.0.0')).toEqual([0, 0, 0, 0]);
    });

    it.each(['256.0.0.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.x', '', '1..2.3'])('refuses IPv4-ish %j', (text) => {
        expect(parseIpAddress(text)).toBeNull();
    });

    it('parses full, compressed and zoned IPv6', () => {
        expect(parseIpAddress('::1')).toEqual({ family: 6, bytes: Uint8Array.of(...new Array<number>(15).fill(0), 1) });
        expect(bytesOf('2001:db8:0:0:0:0:0:ff01')).toEqual(bytesOf('2001:DB8::ff01'));
        expect(bytesOf('::')).toEqual(new Array<number>(16).fill(0));
        expect(bytesOf('fe80::1%eth0')).toEqual(bytesOf('fe80::1'));
        expect(bytesOf('1::')).toEqual([0, 1, ...new Array<number>(14).fill(0)]);
    });

    it('parses IPv6 with an embedded IPv4 tail', () => {
        expect(bytesOf('::ffff:192.0.2.1')).toEqual([...new Array<number>(10).fill(0), 255, 255, 192, 0, 2, 1]);
        expect(bytesOf('::192.0.2.1')).toEqual([...new Array<number>(12).fill(0), 192, 0, 2, 1]);
        expect(bytesOf('1:2:3:4:5:6:192.0.2.1')).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 192, 0, 2, 1]);
        expect(bytesOf('1::192.0.2.1')).toEqual([0, 1, ...new Array<number>(10).fill(0), 192, 0, 2, 1]);
    });

    it.each([
        '1:2:3:4:5:6:7',
        '1:2:3:4:5:6:7:8:9',
        '1::2::3',
        '1:2:3:4:5:6:7::8',
        '12345::',
        'g::1',
        '::ffff:300.0.0.1',
        '1:2:3:4:5:6:7:1.2.3.4',
        ':1',
        'not an address',
    ])('refuses %j', (text) => {
        expect(parseIpAddress(text)).toBeNull();
    });
});

describe('ipLimitKey', () => {
    it('keys IPv4 by address', () => {
        expect(ipLimitKey('192.0.2.1')).toBe('192.0.2.1');
    });

    it('groups IPv6 by /64', () => {
        expect(ipLimitKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
        expect(ipLimitKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(ipLimitKey('2001:DB8:1:2::'));
        expect(ipLimitKey('2001:db8:1:3::1')).not.toBe(ipLimitKey('2001:db8:1:2::1'));
    });

    it('keys anything else as itself', () => {
        expect(ipLimitKey('unix-socket')).toBe('unix-socket');
    });
});
