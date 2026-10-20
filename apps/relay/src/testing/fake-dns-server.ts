import { createSocket } from 'node:dgram';

// A real UDP responder, so the node adapter is tested through c-ares and its error codes rather than a mocked
// `Resolver`. It answers exactly what each test configures and nothing else; it never touches the network beyond
// 127.0.0.1.

export type FakeDnsReply =
    | { readonly kind: 'cname'; readonly targets: readonly string[] }
    | { readonly kind: 'nodata' }
    | { readonly kind: 'nxdomain' }
    | { readonly kind: 'servfail' }
    | { readonly kind: 'silent' };

export interface FakeDnsServer {
    /** `127.0.0.1:<port>`, for `Resolver.setServers`. */
    readonly address: string;
    /** Names without a reply get NXDOMAIN. Matched case-insensitively. */
    answer(name: string, reply: FakeDnsReply): void;
    queries(): number;
    close(): Promise<void>;
}

const HEADER_BYTES = 12;
const MAX_QUERY_BYTES = 512;
const TYPE_CNAME = 5;
const CLASS_IN = 1;
const RCODE = { noError: 0, servFail: 2, nxDomain: 3 } as const;

interface Question {
    readonly id: number;
    readonly recursionDesired: boolean;
    readonly name: string;
    /** QNAME, QTYPE and QCLASS as received, echoed in the reply. */
    readonly bytes: Uint8Array;
}

function parseQuery(packet: Uint8Array): Question | undefined {
    if (packet.length < HEADER_BYTES || packet.length > MAX_QUERY_BYTES) return undefined;
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    if (view.getUint16(4) !== 1) return undefined;
    const labels: string[] = [];
    let offset = HEADER_BYTES;
    for (;;) {
        const length = packet[offset];
        if (length === undefined || length > 63) return undefined;
        offset++;
        if (length === 0) break;
        if (offset + length > packet.length) return undefined;
        labels.push(new TextDecoder().decode(packet.subarray(offset, offset + length)));
        offset += length;
    }
    if (offset + 4 > packet.length) return undefined;
    return {
        id: view.getUint16(0),
        recursionDesired: (view.getUint8(2) & 0x01) === 1,
        name: labels.join('.').toLowerCase(),
        bytes: packet.slice(HEADER_BYTES, offset + 4),
    };
}

function encodeName(name: string): Uint8Array {
    const parts = name
        .replace(/\.$/, '')
        .split('.')
        .map((label) => new TextEncoder().encode(label));
    const out = new Uint8Array(parts.reduce((sum, label) => sum + 1 + label.length, 1));
    let offset = 0;
    for (const label of parts) {
        out[offset++] = label.length;
        out.set(label, offset);
        offset += label.length;
    }
    return out;
}

function buildReply(question: Question, rcode: number, targets: readonly string[]): Uint8Array {
    const answers = targets.map((target) => {
        const rdata = encodeName(target);
        const record = new Uint8Array(12 + rdata.length);
        const view = new DataView(record.buffer);
        view.setUint16(0, 0xc00c);
        view.setUint16(2, TYPE_CNAME);
        view.setUint16(4, CLASS_IN);
        view.setUint32(6, 60);
        view.setUint16(10, rdata.length);
        record.set(rdata, 12);
        return record;
    });
    const length = HEADER_BYTES + question.bytes.length + answers.reduce((sum, record) => sum + record.length, 0);
    const reply = new Uint8Array(length);
    const view = new DataView(reply.buffer);
    view.setUint16(0, question.id);
    view.setUint8(2, 0x80 | (question.recursionDesired ? 0x01 : 0));
    view.setUint8(3, 0x80 | rcode);
    view.setUint16(4, 1);
    view.setUint16(6, answers.length);
    reply.set(question.bytes, HEADER_BYTES);
    let offset = HEADER_BYTES + question.bytes.length;
    for (const record of answers) {
        reply.set(record, offset);
        offset += record.length;
    }
    return reply;
}

function replyFor(question: Question, reply: FakeDnsReply): Uint8Array | undefined {
    switch (reply.kind) {
        case 'cname':
            return buildReply(question, RCODE.noError, reply.targets);
        case 'nodata':
            return buildReply(question, RCODE.noError, []);
        case 'nxdomain':
            return buildReply(question, RCODE.nxDomain, []);
        case 'servfail':
            return buildReply(question, RCODE.servFail, []);
        case 'silent':
            return undefined;
    }
}

export async function startFakeDnsServer(): Promise<FakeDnsServer> {
    const socket = createSocket('udp4');
    const replies = new Map<string, FakeDnsReply>();
    let queries = 0;
    socket.on('message', (packet, remote) => {
        const question = parseQuery(packet);
        if (question === undefined) return;
        queries++;
        const reply = replyFor(question, replies.get(question.name) ?? { kind: 'nxdomain' });
        if (reply !== undefined) socket.send(reply, remote.port, remote.address);
    });
    await new Promise<void>((resolve) => {
        socket.bind(0, '127.0.0.1', resolve);
    });
    const { port } = socket.address();
    return {
        address: `127.0.0.1:${String(port)}`,
        answer(name, reply) {
            replies.set(name.toLowerCase(), reply);
        },
        queries: () => queries,
        close: () =>
            new Promise<void>((resolve) => {
                socket.close(() => {
                    resolve();
                });
            }),
    };
}
