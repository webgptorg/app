// Decodes classic libpcap captures down to TCP segments. Only what tcpdump writes on Linux is supported; anything
// else is reported as unsupported rather than guessed at, so an analysis never passes on bytes it could not read.

export interface Endpoint {
    readonly address: string;
    readonly port: number;
}

export interface TcpFlags {
    readonly syn: boolean;
    readonly ack: boolean;
    readonly fin: boolean;
    readonly rst: boolean;
}

export interface TcpSegment {
    readonly timestampUs: number;
    readonly source: Endpoint;
    readonly destination: Endpoint;
    readonly seq: number;
    readonly flags: TcpFlags;
    readonly payload: Uint8Array;
}

export type LinkType = 'ethernet' | 'linux-sll' | 'linux-sll2' | 'raw';

export type PcapUnsupportedReason = 'pcapng' | 'not-pcap' | 'truncated-file-header' | 'link-type';

export type PcapParse =
    | {
          readonly kind: 'ok';
          readonly linkType: LinkType;
          readonly segments: readonly TcpSegment[];
          /**
           * Packets cut short by the snapshot length or the end of the file. Those missing TCP headers are dropped;
           * those missing only payload keep what was captured.
           */
          readonly truncatedPackets: number;
          /** Packets whose IP or TCP header is inconsistent; they are dropped, so their payload is never seen. */
          readonly malformedPackets: number;
      }
    | { readonly kind: 'unsupported'; readonly reason: PcapUnsupportedReason };

type PacketDecode =
    | { readonly kind: 'segment'; readonly segment: TcpSegment; readonly payloadCut: boolean }
    | { readonly kind: 'ignored' }
    | { readonly kind: 'truncated' }
    | { readonly kind: 'malformed' };

const IGNORED: PacketDecode = { kind: 'ignored' };
const TRUNCATED: PacketDecode = { kind: 'truncated' };
const MALFORMED: PacketDecode = { kind: 'malformed' };

const MAGIC_MICROSECONDS = 0xa1b2c3d4;
const MAGIC_NANOSECONDS = 0xa1b23c4d;
const MAGIC_PCAPNG = 0x0a0d0d0a;
const FILE_HEADER_BYTES = 24;
const RECORD_HEADER_BYTES = 16;

const LINK_TYPES: ReadonlyMap<number, LinkType> = new Map([
    [1, 'ethernet'],
    [101, 'raw'],
    [113, 'linux-sll'],
    [276, 'linux-sll2'],
]);

const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_IPV6 = 0x86dd;
const ETHERTYPE_VLAN = 0x8100;
const ETHERNET_HEADER_BYTES = 14;
const VLAN_TAG_BYTES = 4;
const SLL_HEADER_BYTES = 16;
const SLL2_HEADER_BYTES = 20;

const IPV4_MIN_HEADER_BYTES = 20;
const IPV6_HEADER_BYTES = 40;
const IP_PROTOCOL_TCP = 6;
const TCP_MIN_HEADER_BYTES = 20;

export function parsePcap(bytes: Uint8Array): PcapParse {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 4) return { kind: 'unsupported', reason: 'not-pcap' };
    const magic = view.getUint32(0, true);
    if (magic === MAGIC_PCAPNG) return { kind: 'unsupported', reason: 'pcapng' };
    const format = fileFormat(magic);
    if (format === undefined) return { kind: 'unsupported', reason: 'not-pcap' };
    if (bytes.byteLength < FILE_HEADER_BYTES) return { kind: 'unsupported', reason: 'truncated-file-header' };
    const { littleEndian, nanoseconds } = format;
    // The upper bits of the link-type field carry FCS information, not the link type.
    const linkType = LINK_TYPES.get(view.getUint32(20, littleEndian) & 0xffff);
    if (linkType === undefined) return { kind: 'unsupported', reason: 'link-type' };

    const segments: TcpSegment[] = [];
    let truncatedPackets = 0;
    let malformedPackets = 0;
    let offset = FILE_HEADER_BYTES;
    while (offset < bytes.byteLength) {
        const start = offset + RECORD_HEADER_BYTES;
        if (start > bytes.byteLength) {
            truncatedPackets++;
            break;
        }
        const end = start + view.getUint32(offset + 8, littleEndian);
        if (end > bytes.byteLength) {
            truncatedPackets++;
            break;
        }
        const seconds = view.getUint32(offset, littleEndian);
        const fraction = view.getUint32(offset + 4, littleEndian);
        const timestampUs = seconds * 1_000_000 + (nanoseconds ? Math.floor(fraction / 1_000) : fraction);
        offset = end;

        const decoded = decodeFrame(linkType, bytes.subarray(start, end), timestampUs);
        switch (decoded.kind) {
            case 'segment':
                segments.push(decoded.segment);
                if (decoded.payloadCut) truncatedPackets++;
                break;
            case 'truncated':
                truncatedPackets++;
                break;
            case 'malformed':
                malformedPackets++;
                break;
            case 'ignored':
                break;
        }
    }
    return { kind: 'ok', linkType, segments, truncatedPackets, malformedPackets };
}

export function formatEndpoint(endpoint: Endpoint): string {
    const host = endpoint.address.includes(':') ? `[${endpoint.address}]` : endpoint.address;
    return `${host}:${String(endpoint.port)}`;
}

function fileFormat(magicLittleEndian: number): { littleEndian: boolean; nanoseconds: boolean } | undefined {
    switch (magicLittleEndian) {
        case MAGIC_MICROSECONDS:
            return { littleEndian: true, nanoseconds: false };
        case MAGIC_NANOSECONDS:
            return { littleEndian: true, nanoseconds: true };
        case byteSwap32(MAGIC_MICROSECONDS):
            return { littleEndian: false, nanoseconds: false };
        case byteSwap32(MAGIC_NANOSECONDS):
            return { littleEndian: false, nanoseconds: true };
        default:
            return undefined;
    }
}

function byteSwap32(value: number): number {
    return (((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >>> 8) & 0xff00) | (value >>> 24)) >>> 0;
}

function decodeFrame(linkType: LinkType, frame: Uint8Array, timestampUs: number): PacketDecode {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    switch (linkType) {
        case 'ethernet': {
            if (frame.byteLength < ETHERNET_HEADER_BYTES) return TRUNCATED;
            const etherType = view.getUint16(12);
            if (etherType !== ETHERTYPE_VLAN)
                return decodeEtherType(etherType, frame.subarray(ETHERNET_HEADER_BYTES), timestampUs);
            if (frame.byteLength < ETHERNET_HEADER_BYTES + VLAN_TAG_BYTES) return TRUNCATED;
            return decodeEtherType(
                view.getUint16(16),
                frame.subarray(ETHERNET_HEADER_BYTES + VLAN_TAG_BYTES),
                timestampUs,
            );
        }
        case 'linux-sll':
            if (frame.byteLength < SLL_HEADER_BYTES) return TRUNCATED;
            return decodeEtherType(view.getUint16(14), frame.subarray(SLL_HEADER_BYTES), timestampUs);
        case 'linux-sll2':
            if (frame.byteLength < SLL2_HEADER_BYTES) return TRUNCATED;
            return decodeEtherType(view.getUint16(0), frame.subarray(SLL2_HEADER_BYTES), timestampUs);
        case 'raw':
            if (frame.byteLength < 1) return TRUNCATED;
            return decodeIp(frame, timestampUs);
    }
}

function decodeEtherType(etherType: number, packet: Uint8Array, timestampUs: number): PacketDecode {
    if (etherType !== ETHERTYPE_IPV4 && etherType !== ETHERTYPE_IPV6) return IGNORED;
    if (packet.byteLength < 1) return TRUNCATED;
    const version = (packet[0] ?? 0) >> 4;
    if (version !== (etherType === ETHERTYPE_IPV4 ? 4 : 6)) return MALFORMED;
    return decodeIp(packet, timestampUs);
}

function decodeIp(packet: Uint8Array, timestampUs: number): PacketDecode {
    switch ((packet[0] ?? 0) >> 4) {
        case 4:
            return decodeIpv4(packet, timestampUs);
        case 6:
            return decodeIpv6(packet, timestampUs);
        default:
            return MALFORMED;
    }
}

function decodeIpv4(packet: Uint8Array, timestampUs: number): PacketDecode {
    if (packet.byteLength < IPV4_MIN_HEADER_BYTES) return TRUNCATED;
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const headerBytes = (view.getUint8(0) & 0x0f) * 4;
    if (headerBytes < IPV4_MIN_HEADER_BYTES) return MALFORMED;
    if (packet.byteLength < headerBytes) return TRUNCATED;
    const declaredLength = view.getUint16(2);
    if (view.getUint8(9) !== IP_PROTOCOL_TCP) return IGNORED;
    if ((view.getUint16(6) & 0x1fff) !== 0) return IGNORED;
    // Segmentation offload hands the capture a super-packet whose total length is still 0; trust the capture then.
    const datagramLength = declaredLength === 0 ? packet.byteLength : declaredLength;
    if (datagramLength < headerBytes) return MALFORMED;
    return decodeTcp(
        packet.subarray(headerBytes, Math.min(packet.byteLength, datagramLength)),
        packet.byteLength < datagramLength,
        ipv4Address(packet.subarray(12, 16)),
        ipv4Address(packet.subarray(16, 20)),
        timestampUs,
    );
}

function decodeIpv6(packet: Uint8Array, timestampUs: number): PacketDecode {
    if (packet.byteLength < IPV6_HEADER_BYTES) return TRUNCATED;
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    if (view.getUint8(6) !== IP_PROTOCOL_TCP) return IGNORED;
    const declaredPayload = view.getUint16(4);
    const datagramLength = declaredPayload === 0 ? packet.byteLength : IPV6_HEADER_BYTES + declaredPayload;
    return decodeTcp(
        packet.subarray(IPV6_HEADER_BYTES, Math.min(packet.byteLength, datagramLength)),
        packet.byteLength < datagramLength,
        ipv6Address(packet.subarray(8, 24)),
        ipv6Address(packet.subarray(24, 40)),
        timestampUs,
    );
}

function decodeTcp(
    tcp: Uint8Array,
    payloadCut: boolean,
    sourceAddress: string,
    destinationAddress: string,
    timestampUs: number,
): PacketDecode {
    if (tcp.byteLength < TCP_MIN_HEADER_BYTES) return payloadCut ? TRUNCATED : MALFORMED;
    const view = new DataView(tcp.buffer, tcp.byteOffset, tcp.byteLength);
    const headerBytes = (view.getUint8(12) >> 4) * 4;
    if (headerBytes < TCP_MIN_HEADER_BYTES) return MALFORMED;
    if (tcp.byteLength < headerBytes) return payloadCut ? TRUNCATED : MALFORMED;
    const flags = view.getUint8(13);
    return {
        kind: 'segment',
        payloadCut,
        segment: {
            timestampUs,
            source: { address: sourceAddress, port: view.getUint16(0) },
            destination: { address: destinationAddress, port: view.getUint16(2) },
            seq: view.getUint32(4),
            flags: {
                fin: (flags & 0x01) !== 0,
                syn: (flags & 0x02) !== 0,
                rst: (flags & 0x04) !== 0,
                ack: (flags & 0x10) !== 0,
            },
            payload: tcp.subarray(headerBytes),
        },
    };
}

function ipv4Address(bytes: Uint8Array): string {
    return Array.from(bytes).join('.');
}

/** RFC 5952 text form: lowercase, leading zeros dropped, the longest run of two or more zero groups as `::`. */
function ipv6Address(bytes: Uint8Array): string {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const groups = Array.from({ length: 8 }, (_, index) => view.getUint16(index * 2));
    let bestStart = -1;
    let bestLength = 1;
    for (let start = 0; start < groups.length;) {
        let end = start;
        while (groups[end] === 0) end++;
        if (end - start > bestLength) {
            bestStart = start;
            bestLength = end - start;
        }
        start = end + 1;
    }
    const hex = groups.map((group) => group.toString(16));
    if (bestStart < 0) return hex.join(':');
    return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}
