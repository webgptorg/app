import type { AddressFamily, Bytes } from '@ptbk/protocol';

export interface IpAddress {
    readonly family: AddressFamily;
    /** 4 bytes for IPv4, 16 for IPv6. */
    readonly bytes: Bytes;
}

const IPV4_PART = /^(?:0|[1-9]\d{0,2})$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;
const IPV6_GROUPS = 8;

function parseIpv4(text: string): number[] | null {
    const parts = text.split('.');
    if (parts.length !== 4 || !parts.every((part) => IPV4_PART.test(part) && Number(part) <= 255)) return null;
    return parts.map(Number);
}

function parseGroups(text: string): number[] | null {
    if (text === '') return [];
    const groups = text.split(':');
    return groups.every((group) => IPV6_GROUP.test(group)) ? groups.map((group) => parseInt(group, 16)) : null;
}

function parseIpv6(address: string): number[] | null {
    const zone = address.indexOf('%');
    let text = zone === -1 ? address : address.slice(0, zone);
    const tail: number[] = [];
    const lastColon = text.lastIndexOf(':');
    if (text.includes('.', lastColon)) {
        const ipv4 = parseIpv4(text.slice(lastColon + 1));
        if (ipv4 === null) return null;
        tail.push(...ipv4);
        text = text.slice(0, lastColon);
        // `::1.2.3.4` and `1::1.2.3.4` keep their `::`.
        if (text.endsWith(':')) text += ':';
    }
    const halves = text.split('::');
    const head = parseGroups(halves[0] as string);
    const rest = halves.length === 2 ? parseGroups(halves[1] as string) : [];
    if (halves.length > 2 || head === null || rest === null) return null;
    const present = head.length + rest.length + tail.length / 2;
    const zeros = halves.length === 2 ? IPV6_GROUPS - present : 0;
    if (present + zeros !== IPV6_GROUPS || (halves.length === 2 && zeros < 1)) return null;
    const groups = [...head, ...new Array<number>(zeros).fill(0), ...rest];
    return [...groups.flatMap((group) => [group >> 8, group & 0xff]), ...tail];
}

/** The textual address Node reports for a socket (with an optional IPv6 zone), as bytes; `null` if it is not one. */
export function parseIpAddress(text: string): IpAddress | null {
    const ipv4 = parseIpv4(text);
    if (ipv4 !== null) return { family: 4, bytes: Uint8Array.from(ipv4) };
    const ipv6 = parseIpv6(text);
    return ipv6 === null ? null : { family: 6, bytes: Uint8Array.from(ipv6) };
}

function ipv6Prefix(bytes: Bytes, bits: 64 | 56 | 48): string {
    const masked = new Uint8Array(8);
    masked.set(bytes.subarray(0, bits / 8));
    const groups = Array.from({ length: 4 }, (_, index) =>
        (((masked[index * 2] as number) << 8) | (masked[index * 2 + 1] as number)).toString(16),
    );
    return `${groups.join(':')}::/${String(bits)}`;
}

/**
 * The key per-IP limits count by: the address for IPv4, the /64 prefix for IPv6, because one subscriber usually gets
 * a whole /64 and could otherwise rotate through 2^64 addresses. Text that is no address keys as itself.
 */
export function ipLimitKey(text: string): string {
    const address = parseIpAddress(text);
    return address?.family === 6 ? ipv6Prefix(address.bytes, 64) : text;
}

/** The /56 and /48 around an IPv6 address, where a subscriber or a site holds many /64s; `null` for anything else. */
export function ipv6WiderPrefixes(text: string): { readonly slash56: string; readonly slash48: string } | null {
    const address = parseIpAddress(text);
    if (address?.family !== 6) return null;
    return { slash56: ipv6Prefix(address.bytes, 56), slash48: ipv6Prefix(address.bytes, 48) };
}
