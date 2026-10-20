import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from '../base64url';
import type { Bytes } from '../bytes';
import type { Signer } from '../ed25519';
import { createWebCryptoSigner, importEd25519PrivateKey } from '../ed25519';
import { deriveEngineId } from '../engine-id';
import { EngineId, EngineVersion, ed25519SignatureFromBytes } from '../ids';
import type { Ed25519Signature } from '../ids';
import { SIGNING_CONTEXT, signingInput } from '../signing-input';
import { createSeededRandom } from '../testing/seeded-random';
import { signTunnelAuth, tunnelAuthInput, verifyTunnelAuth } from './auth';
import { TunnelAuth, TunnelChallenge, TunnelFeature } from './handshake';
import type { TunnelFeature as Feature } from './handshake';

const random = createSeededRandom(0x7e57);
const version = EngineVersion.parse('1.8.2');
const features = (...names: string[]): Feature[] => names.map((name) => TunnelFeature.parse(name));

const challenge = TunnelChallenge.parse({
    v: 1,
    type: 'challenge',
    nonce: encodeBase64Url(random.bytes(32)),
    relayId: 'relay-fsn.example.net',
    protocolVersions: [3, 1, 10, 2],
    features: ['zeta', 'ab', 'a-b'],
});
const offer = { version, protocolVersions: [2, 10, 1], features: features('ab', 'x-ray', 'a-b') };

async function signerFromSeed(seed: Uint8Array): Promise<Signer> {
    return createWebCryptoSigner(await importEd25519PrivateKey(Uint8Array.from(seed), { extractable: false }));
}

let signer: Signer;
let other: Signer;
let auth: TunnelAuth;

beforeAll(async () => {
    signer = await signerFromSeed(random.bytes(32));
    other = await signerFromSeed(random.bytes(32));
    auth = await signTunnelAuth(signer, challenge, offer);
});

const withChallenge = (changes: Partial<Record<keyof TunnelChallenge, unknown>>) =>
    TunnelChallenge.parse({ ...challenge, ...changes });
const withAuth = (changes: Partial<Record<keyof TunnelAuth, unknown>>) => TunnelAuth.parse({ ...auth, ...changes });

describe('signTunnelAuth', () => {
    it('builds an auth message that parses and carries the derived engine ID', async () => {
        expect(TunnelAuth.parse(auth)).toEqual(auth);
        expect(auth).toMatchObject({ v: 1, type: 'auth', version: '1.8.2', protocolVersions: [2, 10, 1] });
        expect(auth.engineId).toBe(await deriveEngineId(signer.publicKey()));
    });

    it.each([
        ['duplicate versions', { ...offer, protocolVersions: [1, 1] }],
        ['no versions', { ...offer, protocolVersions: [] }],
        ['a version above u16', { ...offer, protocolVersions: [65_536] }],
        ['duplicate features', { ...offer, features: features('ab', 'ab') }],
    ])('refuses to sign %s', async (_, bad) => {
        await expect(signTunnelAuth(signer, challenge, bad)).rejects.toThrow();
    });

    it('stops when the signal aborts', async () => {
        await expect(signTunnelAuth(signer, challenge, offer, AbortSignal.abort())).rejects.toThrow();
    });
});

describe('verifyTunnelAuth', () => {
    it('passes for a correct signature', () => {
        expect(verifyTunnelAuth(signer.publicKey(), challenge, auth)).toBe(true);
    });

    it('fails for a different relay ID', () => {
        expect(verifyTunnelAuth(signer.publicKey(), withChallenge({ relayId: 'relay-hel.example.net' }), auth)).toBe(
            false,
        );
    });

    it('fails for a different nonce', () => {
        const nonce = encodeBase64Url(random.bytes(32));
        expect(verifyTunnelAuth(signer.publicKey(), withChallenge({ nonce }), auth)).toBe(false);
    });

    it('fails for a different engine ID', async () => {
        const engineId = await deriveEngineId(other.publicKey());
        expect(verifyTunnelAuth(signer.publicKey(), challenge, withAuth({ engineId }))).toBe(false);
    });

    it('fails for a changed engine software version', () => {
        expect(verifyTunnelAuth(signer.publicKey(), challenge, withAuth({ version: '1.8.3' }))).toBe(false);
    });

    it('fails for another key', () => {
        expect(verifyTunnelAuth(other.publicKey(), challenge, auth)).toBe(false);
    });

    it('fails for a hostname-claim signature over the same parts', async () => {
        const parts = [
            challenge.relayId,
            decodeNonce(challenge.nonce),
            auth.engineId,
            version,
            '1,2,3,10',
            'a-b,ab,zeta',
            '1,2,10',
            'a-b,ab,x-ray',
        ];
        expect(verifyTunnelAuth(signer.publicKey(), challenge, auth)).toBe(true);
        expect(signingInput(SIGNING_CONTEXT.tunnel, ...parts)).toEqual(
            tunnelAuthInput(challenge, auth.engineId, {
                version,
                versions: offer.protocolVersions,
                features: offer.features,
            }),
        );
        const sig = ed25519SignatureFromBytes(await signer.sign(signingInput(SIGNING_CONTEXT.hostname, ...parts)));
        expect(verifyTunnelAuth(signer.publicKey(), challenge, withAuth({ sig }))).toBe(false);
    });

    it('never throws on a forged brand', () => {
        expect(verifyTunnelAuth(signer.publicKey(), challenge, { ...auth, sig: '!' as Ed25519Signature })).toBe(false);
        expect(verifyTunnelAuth(signer.publicKey(), challenge, { ...auth, protocolVersions: [1, 1] })).toBe(false);
        expect(verifyTunnelAuth(signer.publicKey(), { ...challenge, nonce: '!' as typeof challenge.nonce }, auth)).toBe(
            false,
        );
    });
});

describe('downgrade: the four signed lists', () => {
    it.each([
        ['relay versions stripped', { protocolVersions: [1] }],
        ['relay versions with one dropped', { protocolVersions: [1, 2, 3] }],
        ['relay versions replaced by another set', { protocolVersions: [3, 1, 9, 2] }],
        ['relay features stripped', { features: [] }],
        ['relay features with one dropped', { features: ['ab', 'a-b'] }],
        ['relay features replaced by another set', { features: ['zeta', 'ab', 'a-c'] }],
    ])('fails when the challenge has %s', (_, changes) => {
        expect(verifyTunnelAuth(signer.publicKey(), withChallenge(changes), auth)).toBe(false);
    });

    it.each([
        ['engine versions stripped', { protocolVersions: [1] }],
        ['engine versions with one added', { protocolVersions: [2, 10, 1, 11] }],
        ['engine versions replaced by another set', { protocolVersions: [2, 9, 1] }],
        ['engine features stripped', { features: [] }],
        ['engine features with one added', { features: ['ab', 'x-ray', 'a-b', 'zeta'] }],
        ['engine features replaced by another set', { features: ['ab', 'x-raz', 'a-b'] }],
    ])('fails when auth has %s', (_, changes) => {
        expect(verifyTunnelAuth(signer.publicKey(), challenge, withAuth(changes))).toBe(false);
    });

    it('passes when only the order of a list changes, because the encoding is canonical', () => {
        expect(verifyTunnelAuth(signer.publicKey(), withChallenge({ protocolVersions: [10, 3, 2, 1] }), auth)).toBe(
            true,
        );
        expect(verifyTunnelAuth(signer.publicKey(), withChallenge({ features: ['a-b', 'zeta', 'ab'] }), auth)).toBe(
            true,
        );
        expect(verifyTunnelAuth(signer.publicKey(), challenge, withAuth({ protocolVersions: [1, 2, 10] }))).toBe(true);
        expect(verifyTunnelAuth(signer.publicKey(), challenge, withAuth({ features: ['x-ray', 'a-b', 'ab'] }))).toBe(
            true,
        );
    });
});

describe('tunnelAuthInput list encoding', () => {
    const engineId = EngineId.parse('eh7ddx5bksrgcytl7bkai36se4');

    function expectedInput(
        relayVersions: string,
        relayFeatures: string,
        engineVersions: string,
        engineFeatures: string,
    ) {
        return signingInput(
            SIGNING_CONTEXT.tunnel,
            challenge.relayId,
            decodeNonce(challenge.nonce),
            engineId,
            version,
            relayVersions,
            relayFeatures,
            engineVersions,
            engineFeatures,
        );
    }

    it('sorts versions numerically and features by byte', () => {
        const input = tunnelAuthInput(challenge, engineId, {
            version,
            versions: [2, 10, 1],
            features: features('ab', 'a-b'),
        });
        expect(input).toEqual(expectedInput('1,2,3,10', 'a-b,ab,zeta', '1,2,10', 'a-b,ab'));
        expect(input).not.toEqual(expectedInput('1,10,2,3', 'a-b,ab,zeta', '1,10,2', 'a-b,ab'));
    });

    it('encodes an empty list as an empty part', () => {
        const empty = withChallenge({ features: [] });
        const input = tunnelAuthInput(empty, engineId, { version, versions: [1], features: [] });
        const expected = signingInput(
            SIGNING_CONTEXT.tunnel,
            challenge.relayId,
            decodeNonce(challenge.nonce),
            engineId,
            version,
            '1,2,3,10',
            '',
            '1',
            '',
        );
        expect(input).toEqual(expected);
    });

    it('puts the nonce in as its raw 32 bytes', () => {
        const input = tunnelAuthInput(challenge, engineId, { version, versions: [1], features: [] });
        const nonce = decodeNonce(challenge.nonce);
        const offset = 9 + 1 + SIGNING_CONTEXT.tunnel.length + 4 + challenge.relayId.length;
        expect([...input.subarray(offset, offset + 4)]).toEqual([0, 0, 0, 32]);
        expect(input.subarray(offset + 4, offset + 36)).toEqual(nonce);
    });

    it('is identical for lists given in any order', () => {
        const versions = fc.uniqueArray(fc.integer({ min: 1, max: 65_535 }), { minLength: 1, maxLength: 8 });
        const names = fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,32}$/), { maxLength: 32 });
        fc.assert(
            fc.property(versions, names, versions, names, fc.nat(), (rv, rf, ev, ef, seed) => {
                const shuffle = <T>(list: readonly T[]): T[] =>
                    list
                        .map((item, index) => ({ item, key: (index * 2_654_435_761 + seed) >>> 0 }))
                        .sort((a, b) => a.key - b.key)
                        .map(({ item }) => item);
                const c = TunnelChallenge.parse({ ...challenge, protocolVersions: rv, features: rf });
                const shuffled = TunnelChallenge.parse({ ...c, protocolVersions: shuffle(rv), features: shuffle(rf) });
                const engine = { version, versions: ev, features: features(...ef) };
                const reordered = { version, versions: shuffle(ev), features: features(...shuffle(ef)) };
                expect(tunnelAuthInput(shuffled, engineId, reordered)).toEqual(tunnelAuthInput(c, engineId, engine));
            }),
            { numRuns: 200 },
        );
    });

    it.each([
        ['duplicate versions', { version, versions: [1, 1], features: [] }],
        ['duplicate features', { version, versions: [1], features: features('ab', 'ab') }],
        ['version 0', { version, versions: [0], features: [] }],
        ['a version above u16', { version, versions: [65_536], features: [] }],
        ['a fractional version', { version, versions: [1.5], features: [] }],
    ])('throws on %s, which parsed messages never contain', (_, engine) => {
        expect(() => tunnelAuthInput(challenge, engineId, engine)).toThrow(RangeError);
    });
});

function decodeNonce(nonce: string): Bytes {
    const decoded = decodeBase64Url(nonce);
    if (decoded.kind !== 'ok') throw new TypeError('bad nonce');
    return decoded.bytes;
}
