// Writes src/tunnel/vectors.json: golden frames and a signed handshake for the engine team (C-02).
//
//   node packages/protocol/scripts/generate-tunnel-vectors.ts
//
// Deliberately independent of src/: every byte is assembled here by hand (Buffer, node:crypto), so
// src/tunnel/vectors.test.ts checks the package's codec and signing input against a second implementation.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

// RFC 8032 §7.1 TEST 1, so the key is recognisable and its public key checkable.
const SEED = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, SEED]), format: 'der', type: 'pkcs8' });
const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32));
if (hex(publicKey) !== 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a') {
    throw new Error('seed does not give the RFC 8032 TEST 1 public key');
}

function base32Lower(bytes: Uint8Array): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = '';
    for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
    let text = '';
    for (let index = 0; index + 5 <= bits.length; index += 5)
        text += alphabet.charAt(parseInt(bits.slice(index, index + 5), 2));
    return text;
}

const engineId = base32Lower(createHash('sha256').update(publicKey).digest()).slice(0, 26);

function part(value: string | Uint8Array): Buffer {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
}

function signingInput(context: string, ...parts: (string | Uint8Array)[]): Buffer {
    return Buffer.concat([
        Buffer.from('ptbk-sig\0'),
        Buffer.of(context.length),
        Buffer.from(context),
        ...parts.map(part),
    ]);
}

const versionsPart = (versions: readonly number[]): string => [...versions].sort((a, b) => a - b).join(',');
const featuresPart = (features: readonly string[]): string =>
    [...features].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join(',');

interface Challenge {
    v: 1;
    type: 'challenge';
    nonce: string;
    relayId: string;
    protocolVersions: number[];
    features: string[];
}

interface Auth {
    v: 1;
    type: 'auth';
    engineId: string;
    version: string;
    protocolVersions: number[];
    features: string[];
    sig: string;
}

const nonce = Uint8Array.from({ length: 32 }, (_, index) => index);
const challenge: Challenge = {
    v: 1,
    type: 'challenge',
    nonce: b64url(nonce),
    relayId: 'relay-fsn.example.net',
    protocolVersions: [3, 1, 10, 2],
    features: ['zeta', 'ab', 'a-b'],
};
const engine = { version: '1.8.2', protocolVersions: [2, 10, 1], features: ['ab', 'x-ray', 'a-b'] };

function authInput(c: Challenge, a: Omit<Auth, 'sig' | 'v' | 'type'>): Buffer {
    const raw = Buffer.from(c.nonce, 'base64url');
    return signingInput(
        'ptbk-tunnel-v1',
        c.relayId,
        raw,
        a.engineId,
        a.version,
        versionsPart(c.protocolVersions),
        featuresPart(c.features),
        versionsPart(a.protocolVersions),
        featuresPart(a.features),
    );
}

const input = authInput(challenge, { engineId, ...engine });
const signature = sign(null, input, privateKey);
const auth: Auth = { v: 1, type: 'auth', engineId, ...engine, sig: b64url(signature) };
if (!verify(null, input, createPublicKey(privateKey), signature)) throw new Error('signature does not verify');

const ready = {
    v: 1,
    type: 'ready',
    protocolVersion: 10,
    features: ['a-b', 'ab'],
    hostnames: [`${engineId}.example.com`],
};

const verifies = (c: Challenge, a: Auth): boolean =>
    verify(null, authInput(c, a), createPublicKey(privateKey), Buffer.from(a.sig, 'base64url'));

const authNegatives: readonly (readonly [string, string, Challenge, Auth])[] = [
    [
        'relay-versions-stripped',
        'challenge.protocolVersions reduced to [1]',
        { ...challenge, protocolVersions: [1] },
        auth,
    ],
    ['relay-features-stripped', 'challenge.features emptied', { ...challenge, features: [] }, auth],
    ['engine-versions-stripped', 'auth.protocolVersions reduced to [1]', challenge, { ...auth, protocolVersions: [1] }],
    [
        'engine-features-altered',
        'auth.features with x-ray replaced by x-raz',
        challenge,
        { ...auth, features: ['ab', 'x-raz', 'a-b'] },
    ],
    ['other-relay', 'challenge.relayId of another relay', { ...challenge, relayId: 'relay-hel.example.net' }, auth],
    [
        'other-nonce',
        'challenge.nonce with the last byte changed',
        { ...challenge, nonce: b64url(Uint8Array.from(nonce, (byte, index) => (index === 31 ? 0xff : byte))) },
        auth,
    ],
    ['changed-version', 'auth.version changed to 1.8.3', challenge, { ...auth, version: '1.8.3' }],
];

const handshake = {
    seed: hex(SEED),
    publicKey: hex(publicKey),
    engineId,
    challenge: JSON.stringify(challenge),
    auth: JSON.stringify(auth),
    parts: {
        context: 'ptbk-tunnel-v1',
        relayId: challenge.relayId,
        nonce: hex(nonce),
        engineId,
        version: engine.version,
        relayVersions: versionsPart(challenge.protocolVersions),
        relayFeatures: featuresPart(challenge.features),
        engineVersions: versionsPart(engine.protocolVersions),
        engineFeatures: featuresPart(engine.features),
    },
    signingInput: hex(input),
    signature: hex(signature),
    ready: JSON.stringify(ready),
    invalidAuth: authNegatives.map(([id, description, c, a]) => {
        if (verifies(c, a)) throw new Error(`${id} unexpectedly verifies`);
        return { id, description, challenge: JSON.stringify(c), auth: JSON.stringify(a), valid: false };
    }),
    mismatchedReady: (
        [
            ['lower-version', 'protocolVersion 2 instead of 10', { ...ready, protocolVersion: 2 }],
            ['missing-feature', 'features without ab', { ...ready, features: ['a-b'] }],
            [
                'extra-feature',
                'features with zeta, which the engine did not offer',
                { ...ready, features: ['a-b', 'ab', 'zeta'] },
            ],
        ] as const satisfies readonly (readonly [string, string, object])[]
    ).map(([id, description, r]) => ({ id, description, ready: JSON.stringify(r), result: 'negotiation-mismatch' })),
};

function frame(type: number, streamId: number, payload: Uint8Array = new Uint8Array()): string {
    const header = Buffer.alloc(5);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(streamId, 1);
    return hex(Buffer.concat([header, payload]));
}

const u16 = (value: number): Buffer => {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
};
const u32 = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
};
const IPV4 = Buffer.of(203, 0, 113, 7);
const IPV6 = Buffer.from('20010db8000000000000000000000001', 'hex');
const MAX_PAYLOAD = 65_536;

const frames = {
    valid: [
        {
            id: 'open-ipv4',
            hex: frame(1, 1, Buffer.concat([Buffer.of(4), IPV4, u16(51_234)])),
            frame: { type: 'OPEN', streamId: 1, family: 4, address: hex(IPV4), port: 51_234 },
        },
        {
            id: 'open-ipv6',
            hex: frame(1, 2, Buffer.concat([Buffer.of(6), IPV6, u16(443)])),
            frame: { type: 'OPEN', streamId: 2, family: 6, address: hex(IPV6), port: 443 },
        },
        {
            id: 'data',
            hex: frame(2, 1, Buffer.from('hello')),
            frame: { type: 'DATA', streamId: 1, payload: hex(Buffer.from('hello')) },
        },
        {
            id: 'data-max-stream-id',
            hex: frame(2, 0xffff_ffff, Buffer.of(0)),
            frame: { type: 'DATA', streamId: 0xffff_ffff, payload: '00' },
        },
        { id: 'close-flow-control', hex: frame(3, 7, Buffer.of(4)), frame: { type: 'CLOSE', streamId: 7, code: 4 } },
        { id: 'window', hex: frame(4, 1, u32(65_536)), frame: { type: 'WINDOW', streamId: 1, increment: 65_536 } },
        {
            id: 'window-max',
            hex: frame(4, 1, u32(0x7fff_ffff)),
            frame: { type: 'WINDOW', streamId: 1, increment: 0x7fff_ffff },
        },
    ],
    ignored: [
        { id: 'reserved-code-ignorable', hex: frame(0x85, 0, Buffer.from('future')), typeCode: 5 },
        { id: 'highest-code-ignorable', hex: frame(0xff, 9, new Uint8Array()), typeCode: 127 },
    ],
    invalid: [
        { id: 'too-short', hex: '02000000', reason: 'too-short' },
        { id: 'code-zero', hex: frame(0x00, 1, Buffer.of(1)), reason: 'unknown-type' },
        { id: 'code-zero-ignorable', hex: frame(0x80, 1, Buffer.of(1)), reason: 'unknown-type' },
        { id: 'reserved-code', hex: frame(0x05, 1, Buffer.of(1)), reason: 'unknown-type' },
        { id: 'known-code-ignorable', hex: frame(0x82, 1, Buffer.of(1)), reason: 'bad-flags' },
        { id: 'stream-id-zero', hex: frame(2, 0, Buffer.of(1)), reason: 'stream-id-zero' },
        { id: 'empty-data', hex: frame(2, 1), reason: 'empty-data' },
        {
            id: 'open-bad-family',
            hex: frame(1, 1, Buffer.concat([Buffer.of(5), IPV4, u16(1)])),
            reason: 'bad-open-payload',
        },
        {
            id: 'open-ipv4-trailing',
            hex: frame(1, 1, Buffer.concat([Buffer.of(4), IPV4, u16(1), Buffer.of(0)])),
            reason: 'bad-open-payload',
        },
        { id: 'close-empty', hex: frame(3, 1), reason: 'too-short' },
        { id: 'close-trailing', hex: frame(3, 1, Buffer.of(0, 0)), reason: 'trailing-bytes' },
        { id: 'close-unknown-code', hex: frame(3, 1, Buffer.of(5)), reason: 'bad-close-code' },
        { id: 'window-zero', hex: frame(4, 1, u32(0)), reason: 'bad-window-increment' },
        { id: 'window-over-max', hex: frame(4, 1, u32(0x8000_0000)), reason: 'bad-window-increment' },
        { id: 'window-short', hex: frame(4, 1, Buffer.of(0, 0, 1)), reason: 'too-short' },
    ],
    // Too large to inline: a DATA frame of MAX_FRAME_PAYLOAD_BYTES + 1 zero bytes on stream 1 is `payload-too-large`.
    oversizeDataPayloadBytes: MAX_PAYLOAD + 1,
};

const document = {
    description:
        'Golden vectors for the Promptbook tunnel protocol v1 (C-02, ADR 0010, ADR 0014). Hex unless noted; handshake messages are the exact JSON texts. Generated by packages/protocol/scripts/generate-tunnel-vectors.ts, independently of the package code that src/tunnel/vectors.test.ts checks against them.',
    frameLayout: '[u8 type][u32 streamId, big-endian][payload], one frame per binary WebSocket message',
    signingInput:
        '"ptbk-sig\\0" ‖ u8 len(context) ‖ context ‖ (u32be len(part) ‖ part)… with parts relayId, nonce (raw 32 bytes), engineId, version, relayVersions, relayFeatures, engineVersions, engineFeatures; versions sorted numerically and decimal, features sorted by byte, each list comma-joined',
    handshake,
    frames,
};

writeFileSync(
    join(import.meta.dirname, '..', 'src', 'tunnel', 'vectors.json'),
    `${JSON.stringify(document, null, 2)}\n`,
);
