import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '../base64url';
import { MAX_HANDSHAKE_MESSAGE_BYTES, MAX_PROTOCOL_VERSION } from './constants';
import {
    TunnelAuth,
    TunnelChallenge,
    TunnelFeature,
    TunnelReady,
    checkTunnelReady,
    negotiateTunnel,
    parseEngineMessage,
    parseRelayMessage,
} from './handshake';

const ENGINE_ID = 'eh7ddx5bksrgcytl7bkai36se4';
const SIG = encodeBase64Url(new Uint8Array(64));

const challenge = {
    v: 1,
    type: 'challenge',
    nonce: encodeBase64Url(new Uint8Array(32).fill(1)),
    relayId: 'relay-fsn.example.net',
    protocolVersions: [1, 2],
    features: ['ab'],
};
const auth = {
    v: 1,
    type: 'auth',
    engineId: ENGINE_ID,
    version: '1.8.2',
    protocolVersions: [2, 1],
    features: ['ab', 'cd'],
    sig: SIG,
};
const ready = {
    v: 1,
    type: 'ready',
    protocolVersion: 2,
    features: ['ab'],
    hostnames: [`${ENGINE_ID}.example.com`],
};
const reject = { v: 1, type: 'reject', reason: 'rate-limited' };

const text = (message: unknown): string => JSON.stringify(message);
const features = (...names: string[]) => names.map((name) => TunnelFeature.parse(name));

describe('parseRelayMessage and parseEngineMessage', () => {
    it.each([challenge, ready, reject])('accepts a valid relay $type', (message) => {
        expect(parseRelayMessage(text(message))).toMatchObject({ kind: 'ok', message: { type: message.type } });
    });

    it('accepts a valid auth', () => {
        expect(parseEngineMessage(text(auth))).toEqual({ kind: 'ok', message: auth });
    });

    it.each(['auth-failed', 'suspended', 'unsupported-version', 'timeout', 'rate-limited'])(
        'accepts reject reason %s',
        (reason) => {
            expect(parseRelayMessage(text({ ...reject, reason })).kind).toBe('ok');
        },
    );

    it('keeps the directions apart', () => {
        expect(parseRelayMessage(text(auth))).toEqual({ kind: 'invalid' });
        expect(parseEngineMessage(text(challenge))).toEqual({ kind: 'invalid' });
    });

    it.each([
        ['not JSON', '{"v":1,'],
        ['an array', '[]'],
        ['null', 'null'],
        ['an empty string', ''],
        ['an unknown type', text({ ...auth, type: 'hello' })],
        ['an unknown reject reason', text({ ...reject, reason: 'banned' })],
    ])('rejects %s', (_, input) => {
        expect(parseRelayMessage(input)).toEqual({ kind: 'invalid' });
        expect(parseEngineMessage(input)).toEqual({ kind: 'invalid' });
    });

    describe.each([
        ['challenge', challenge, parseRelayMessage],
        ['auth', auth, parseEngineMessage],
        ['ready', ready, parseRelayMessage],
        ['reject', reject, parseRelayMessage],
    ] as const)('%s', (_, message, parse) => {
        it('rejects an unknown field', () => {
            expect(parse(text({ ...message, extra: true }))).toEqual({ kind: 'invalid' });
        });

        it('rejects a __proto__ field', () => {
            expect(parse(text(message).replace('{', '{"__proto__":{"x":1},'))).toEqual({ kind: 'invalid' });
        });

        it('rejects a missing v', () => {
            const rest: Record<string, unknown> = { ...message };
            delete rest['v'];
            expect(parse(text(rest))).toEqual({ kind: 'invalid' });
        });

        it.each([2, 0, '1', null])('rejects v: %j', (v) => {
            expect(parse(text({ ...message, v }))).toEqual({ kind: 'invalid' });
        });
    });

    it.each([31, 33, 0])('rejects a %i-byte nonce', (length) => {
        expect(parseRelayMessage(text({ ...challenge, nonce: encodeBase64Url(new Uint8Array(length)) }))).toEqual({
            kind: 'invalid',
        });
    });

    it('rejects a padded or standard-base64 nonce', () => {
        const nonce = encodeBase64Url(new Uint8Array(32).fill(0xff));
        expect(parseRelayMessage(text({ ...challenge, nonce: `${nonce}=` })).kind).toBe('invalid');
        expect(parseRelayMessage(text({ ...challenge, nonce: nonce.replaceAll('_', '/') })).kind).toBe('invalid');
    });

    it('rejects an uppercase or malformed engine ID', () => {
        expect(parseEngineMessage(text({ ...auth, engineId: ENGINE_ID.toUpperCase() }))).toEqual({ kind: 'invalid' });
        expect(parseEngineMessage(text({ ...auth, engineId: ENGINE_ID.slice(1) }))).toEqual({ kind: 'invalid' });
    });

    it('rejects a version that is not SemVer', () => {
        expect(parseEngineMessage(text({ ...auth, version: 'v1.8.2' })).kind).toBe('invalid');
    });

    it.each([
        ['empty', []],
        ['duplicated', [1, 1]],
        ['nine entries', [1, 2, 3, 4, 5, 6, 7, 8, 9]],
        ['zero', [0]],
        ['negative', [-1]],
        ['fractional', [1.5]],
        ['above MAX_PROTOCOL_VERSION', [MAX_PROTOCOL_VERSION + 1]],
        ['a string', ['1']],
    ])('rejects %s protocolVersions in challenge and auth', (_, protocolVersions) => {
        expect(parseRelayMessage(text({ ...challenge, protocolVersions }))).toEqual({ kind: 'invalid' });
        expect(parseEngineMessage(text({ ...auth, protocolVersions }))).toEqual({ kind: 'invalid' });
    });

    it('accepts eight versions up to MAX_PROTOCOL_VERSION', () => {
        const protocolVersions = [1, 2, 3, 4, 5, 6, 7, MAX_PROTOCOL_VERSION];
        expect(parseRelayMessage(text({ ...challenge, protocolVersions })).kind).toBe('ok');
        expect(parseEngineMessage(text({ ...auth, protocolVersions })).kind).toBe('ok');
    });

    it.each([
        ['duplicated', ['ab', 'ab']],
        ['uppercase', ['Ab']],
        ['empty name', ['']],
        ['33 characters', ['a'.repeat(33)]],
        ['33 entries', Array.from({ length: 33 }, (_, index) => `f${String(index)}`)],
        ['a comma', ['a,b']],
    ])('rejects %s features in challenge and auth', (_, list) => {
        expect(parseRelayMessage(text({ ...challenge, features: list }))).toEqual({ kind: 'invalid' });
        expect(parseEngineMessage(text({ ...auth, features: list }))).toEqual({ kind: 'invalid' });
    });

    it('accepts 32 features of 32 characters in any order in challenge and auth', () => {
        const list = Array.from({ length: 32 }, (_, index) => `${String(index).padStart(2, '0')}${'z'.repeat(30)}`);
        const reversed = list.toReversed();
        expect(parseRelayMessage(text({ ...challenge, features: reversed })).kind).toBe('ok');
        expect(parseEngineMessage(text({ ...auth, features: reversed })).kind).toBe('ok');
    });

    it('requires ready.features sorted by byte and unique', () => {
        expect(parseRelayMessage(text({ ...ready, features: ['a-b', 'ab'] })).kind).toBe('ok');
        expect(parseRelayMessage(text({ ...ready, features: [] })).kind).toBe('ok');
        expect(parseRelayMessage(text({ ...ready, features: ['ab', 'a-b'] })).kind).toBe('invalid');
        expect(parseRelayMessage(text({ ...ready, features: ['ab', 'ab'] })).kind).toBe('invalid');
    });

    it.each([0, MAX_PROTOCOL_VERSION + 1, 1.5])('rejects ready.protocolVersion %d', (protocolVersion) => {
        expect(parseRelayMessage(text({ ...ready, protocolVersion })).kind).toBe('invalid');
    });

    it('lowercases ready.hostnames and rejects duplicates after lowercasing', () => {
        const upper = parseRelayMessage(text({ ...ready, hostnames: ['Agents.Example.COM'] }));
        expect(upper).toMatchObject({ kind: 'ok', message: { hostnames: ['agents.example.com'] } });
        const duplicate = { ...ready, hostnames: ['agents.example.com', 'AGENTS.example.com'] };
        expect(parseRelayMessage(text(duplicate)).kind).toBe('invalid');
    });

    it.each([
        ['no hostnames', []],
        ['33 hostnames', Array.from({ length: 33 }, (_, index) => `h${String(index)}.example.com`)],
        ['an IP literal', ['192.0.2.1']],
    ])('rejects ready with %s', (_, hostnames) => {
        expect(parseRelayMessage(text({ ...ready, hostnames })).kind).toBe('invalid');
    });

    it('rejects an invalid relayId', () => {
        expect(parseRelayMessage(text({ ...challenge, relayId: 'localhost' })).kind).toBe('invalid');
    });

    it('refuses a message over MAX_HANDSHAKE_MESSAGE_BYTES without parsing it, counting UTF-8 bytes', () => {
        const base = text(reject);
        const padded = (length: number, filler: string) =>
            base.replace('{', `{${' '.repeat(length - base.length - filler.length)}${filler}`);
        expect(parseRelayMessage(padded(MAX_HANDSHAKE_MESSAGE_BYTES, '')).kind).toBe('ok');
        expect(parseRelayMessage(padded(MAX_HANDSHAKE_MESSAGE_BYTES + 1, '')).kind).toBe('invalid');
        // 4 096 UTF-16 code units, but the two-byte "é" makes it 4 097 UTF-8 bytes.
        const multiByte = `${base.slice(0, -1)},"é":${' '.repeat(MAX_HANDSHAKE_MESSAGE_BYTES - base.length - 6)}0}`;
        expect(multiByte).toHaveLength(MAX_HANDSHAKE_MESSAGE_BYTES);
        expect(parseRelayMessage(multiByte)).toEqual({ kind: 'invalid' });
    });
});

describe('negotiateTunnel', () => {
    const offer = (versions: number[], names: string[]) => ({ versions, features: features(...names) });

    it('picks the highest common version', () => {
        expect(negotiateTunnel(offer([1, 2, 3], []), offer([2, 1], []))).toEqual({
            kind: 'ok',
            protocolVersion: 2,
            features: [],
        });
        expect(negotiateTunnel(offer([10, 2], []), offer([2, 10, 1], []))).toMatchObject({ protocolVersion: 10 });
    });

    it('returns exactly the shared features, sorted by byte', () => {
        expect(negotiateTunnel(offer([1], ['ab', 'zeta', 'a-b']), offer([1], ['x', 'ab', 'a-b']))).toEqual({
            kind: 'ok',
            protocolVersion: 1,
            features: ['a-b', 'ab'],
        });
    });

    it('ignores features only one side knows', () => {
        expect(negotiateTunnel(offer([1], []), offer([1], ['future-thing']))).toMatchObject({ features: [] });
        expect(negotiateTunnel(offer([1], ['future-thing']), offer([1], []))).toMatchObject({ features: [] });
    });

    it('returns unsupported-version with no overlap', () => {
        expect(negotiateTunnel(offer([1], ['ab']), offer([2, 3], ['ab']))).toEqual({ kind: 'unsupported-version' });
    });
});

describe('checkTunnelReady', () => {
    const signedChallenge = TunnelChallenge.parse({
        ...challenge,
        protocolVersions: [1, 2, 3],
        features: ['ab', 'cd', 'zz'],
    });
    const signedAuth = TunnelAuth.parse({ ...auth, protocolVersions: [2, 3, 4], features: ['zz', 'ab', 'ef'] });
    const answer = (protocolVersion: number, list: string[]) =>
        TunnelReady.parse({ ...ready, protocolVersion, features: list });

    it('accepts the highest common version with exactly the intersection', () => {
        expect(checkTunnelReady(signedChallenge, signedAuth, answer(3, ['ab', 'zz']))).toEqual({ kind: 'ok' });
    });

    it.each([
        ['a lower common version', 2, ['ab', 'zz']],
        ['a version the engine did not offer', 1, ['ab', 'zz']],
        ['a version the relay did not offer', 4, ['ab', 'zz']],
        ['a missing shared feature', 3, ['ab']],
        ['an extra feature', 3, ['ab', 'cd', 'zz']],
        ['no features', 3, []],
    ])('rejects %s', (_, protocolVersion, list) => {
        expect(checkTunnelReady(signedChallenge, signedAuth, answer(protocolVersion, list))).toEqual({
            kind: 'negotiation-mismatch',
        });
    });

    it('rejects any ready when the signed lists share no version', () => {
        const disjoint = TunnelAuth.parse({ ...auth, protocolVersions: [7] });
        expect(checkTunnelReady(signedChallenge, disjoint, answer(1, []))).toEqual({ kind: 'negotiation-mismatch' });
    });
});
