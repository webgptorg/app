// Builds pcap files for tests, so no capture is ever committed. Checksums are left zero: the parser never reads them.
import type { Endpoint, TcpFlags } from '../pcap.ts';

export interface TestPacket {
    readonly source: Endpoint;
    readonly destination: Endpoint;
    readonly seq: number;
    readonly flags?: Partial<TcpFlags>;
    readonly payload?: Uint8Array;
    readonly timestampUs?: number;
    readonly vlanTag?: boolean;
    readonly ipOptionBytes?: number;
    readonly tcpOptionBytes?: number;
    readonly fragmentOffset?: number;
    /** Bytes after the IP datagram, as Ethernet pads short frames. */
    readonly trailer?: Uint8Array;
    /** Cuts the captured frame to this many bytes, as a short snapshot length does. */
    readonly capturedBytes?: number;
}

export interface PcapWriterOptions {
    readonly littleEndian?: boolean;
    readonly nanoseconds?: boolean;
    readonly linkType?: 'ethernet' | 'linux-sll' | 'linux-sll2' | 'raw';
}

const LINK_TYPE_NUMBERS = { ethernet: 1, raw: 101, 'linux-sll': 113, 'linux-sll2': 276 } as const;

export function buildPcap(packets: readonly TestPacket[], options: PcapWriterOptions = {}): Uint8Array {
    const littleEndian = options.littleEndian ?? true;
    const linkType = options.linkType ?? 'ethernet';
    const header = new DataView(new ArrayBuffer(24));
    header.setUint32(0, options.nanoseconds === true ? 0xa1b23c4d : 0xa1b2c3d4, littleEndian);
    header.setUint16(4, 2, littleEndian);
    header.setUint16(6, 4, littleEndian);
    header.setUint32(16, 262_144, littleEndian);
    header.setUint32(20, LINK_TYPE_NUMBERS[linkType], littleEndian);
    const parts: Uint8Array[] = [new Uint8Array(header.buffer)];
    packets.forEach((packet, index) => {
        const frame = linkFrame(linkType, packet);
        const captured = frame.subarray(0, packet.capturedBytes ?? frame.byteLength);
        const timestampUs = packet.timestampUs ?? 1_700_000_000_000_000 + index * 1_000;
        const fraction = timestampUs % 1_000_000;
        const record = new DataView(new ArrayBuffer(16));
        record.setUint32(0, Math.floor(timestampUs / 1_000_000), littleEndian);
        record.setUint32(4, options.nanoseconds === true ? fraction * 1_000 : fraction, littleEndian);
        record.setUint32(8, captured.byteLength, littleEndian);
        record.setUint32(12, frame.byteLength, littleEndian);
        parts.push(new Uint8Array(record.buffer), captured);
    });
    return concat(parts);
}

export interface Conversation {
    readonly client: Endpoint;
    readonly server: Endpoint;
    readonly clientIsn?: number;
    readonly serverIsn?: number;
    /** Each message is sent as one segment. */
    readonly messages: readonly { readonly from: 'client' | 'server'; readonly data: Uint8Array }[];
    readonly close?: boolean;
}

/** A complete connection: three-way handshake, the messages in order, then a FIN from each side. */
export function tcpConversation(conversation: Conversation): TestPacket[] {
    const { client, server } = conversation;
    let clientSeq = conversation.clientIsn ?? 1_000;
    let serverSeq = conversation.serverIsn ?? 5_000;
    const packets: TestPacket[] = [
        { source: client, destination: server, seq: clientSeq, flags: { syn: true }, tcpOptionBytes: 4 },
        { source: server, destination: client, seq: serverSeq, flags: { syn: true, ack: true }, tcpOptionBytes: 4 },
    ];
    clientSeq = (clientSeq + 1) >>> 0;
    serverSeq = (serverSeq + 1) >>> 0;
    packets.push({ source: client, destination: server, seq: clientSeq, flags: { ack: true } });
    for (const { from, data } of conversation.messages) {
        if (from === 'client') {
            packets.push({ source: client, destination: server, seq: clientSeq, flags: { ack: true }, payload: data });
            clientSeq = (clientSeq + data.byteLength) >>> 0;
        } else {
            packets.push({ source: server, destination: client, seq: serverSeq, flags: { ack: true }, payload: data });
            serverSeq = (serverSeq + data.byteLength) >>> 0;
        }
    }
    if (conversation.close !== false) {
        packets.push(
            { source: client, destination: server, seq: clientSeq, flags: { fin: true, ack: true } },
            { source: server, destination: client, seq: serverSeq, flags: { fin: true, ack: true } },
        );
    }
    return packets;
}

function linkFrame(linkType: NonNullable<PcapWriterOptions['linkType']>, packet: TestPacket): Uint8Array {
    const datagram = ipDatagram(packet);
    const etherType = datagram[0] === 0x60 ? 0x86dd : 0x0800;
    const trailer = packet.trailer ?? new Uint8Array(0);
    switch (linkType) {
        case 'ethernet': {
            const header = new DataView(new ArrayBuffer(packet.vlanTag === true ? 18 : 14));
            header.setUint16(0, 0x0200);
            header.setUint16(6, 0x0200);
            header.setUint8(11, 1);
            if (packet.vlanTag === true) {
                header.setUint16(12, 0x8100);
                header.setUint16(14, 42);
            }
            header.setUint16(header.byteLength - 2, etherType);
            return concat([new Uint8Array(header.buffer), datagram, trailer]);
        }
        case 'linux-sll': {
            const header = new DataView(new ArrayBuffer(16));
            header.setUint16(2, 1);
            header.setUint16(4, 6);
            header.setUint16(14, etherType);
            return concat([new Uint8Array(header.buffer), datagram, trailer]);
        }
        case 'linux-sll2': {
            const header = new DataView(new ArrayBuffer(20));
            header.setUint16(0, etherType);
            header.setUint32(4, 2);
            header.setUint16(8, 1);
            header.setUint8(11, 6);
            return concat([new Uint8Array(header.buffer), datagram, trailer]);
        }
        case 'raw':
            return concat([datagram, trailer]);
    }
}

function ipDatagram(packet: TestPacket): Uint8Array {
    const segment = tcpSegment(packet);
    const source = ipAddressBytes(packet.source.address);
    const destination = ipAddressBytes(packet.destination.address);
    if (source.byteLength === 16) {
        const header = new DataView(new ArrayBuffer(40));
        header.setUint8(0, 0x60);
        header.setUint16(4, segment.byteLength);
        header.setUint8(6, 6);
        header.setUint8(7, 64);
        const bytes = new Uint8Array(header.buffer);
        bytes.set(source, 8);
        bytes.set(destination, 24);
        return concat([bytes, segment]);
    }
    const headerBytes = 20 + (packet.ipOptionBytes ?? 0);
    const header = new DataView(new ArrayBuffer(headerBytes));
    header.setUint8(0, 0x40 | (headerBytes / 4));
    header.setUint16(2, headerBytes + segment.byteLength);
    header.setUint16(6, packet.fragmentOffset ?? 0x4000);
    header.setUint8(8, 64);
    header.setUint8(9, 6);
    const bytes = new Uint8Array(header.buffer);
    bytes.set(source, 12);
    bytes.set(destination, 16);
    return concat([bytes, segment]);
}

function tcpSegment(packet: TestPacket): Uint8Array {
    const headerBytes = 20 + (packet.tcpOptionBytes ?? 0);
    const header = new DataView(new ArrayBuffer(headerBytes));
    const flags = packet.flags ?? {};
    header.setUint16(0, packet.source.port);
    header.setUint16(2, packet.destination.port);
    header.setUint32(4, packet.seq >>> 0);
    header.setUint8(12, (headerBytes / 4) << 4);
    header.setUint8(
        13,
        (flags.fin === true ? 0x01 : 0) |
            (flags.syn === true ? 0x02 : 0) |
            (flags.rst === true ? 0x04 : 0) |
            (flags.ack === true ? 0x10 : 0),
    );
    header.setUint16(14, 0xffff);
    for (let offset = 20; offset < headerBytes; offset++) header.setUint8(offset, 1);
    return concat([new Uint8Array(header.buffer), packet.payload ?? new Uint8Array(0)]);
}

function ipAddressBytes(address: string): Uint8Array {
    if (!address.includes(':')) return Uint8Array.from(address.split('.').map(Number));
    const [head = '', tail] = address.split('::');
    const groupsOf = (part: string | undefined): number[] =>
        part === undefined || part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
    const before = groupsOf(head);
    const after = groupsOf(tail);
    const groups = [...before, ...Array<number>(8 - before.length - after.length).fill(0), ...after];
    const view = new DataView(new ArrayBuffer(16));
    groups.forEach((group, index) => {
        view.setUint16(index * 2, group);
    });
    return new Uint8Array(view.buffer);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }
    return bytes;
}
