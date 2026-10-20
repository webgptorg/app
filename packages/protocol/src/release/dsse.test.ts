import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '../base64url';
import { encodeBase64Std } from '../base64std';
import { utf8Encode } from '../bytes';
import { toHex } from '../testing/hex';
import { releaseTestKeys } from '../testing/release';
import {
    DSSE_MAX_PAYLOAD_BYTES,
    DsseEnvelope,
    RELEASE_PAYLOAD_TYPE,
    REVOCATION_PAYLOAD_TYPE,
    dsseKeyId,
    pae,
    signDsse,
    verifyDsseSignatures,
} from './dsse';

const KEY_ID = encodeBase64Url(new Uint8Array(32).fill(7));
const SIG = encodeBase64Std(new Uint8Array(64).fill(9));
const valid = { payloadType: RELEASE_PAYLOAD_TYPE, payload: 'e30=', signatures: [{ keyid: KEY_ID, sig: SIG }] };

function withSig(signature: Record<string, unknown>) {
    return { ...valid, signatures: [{ keyid: KEY_ID, sig: SIG, ...signature }] };
}

describe('DsseEnvelope', () => {
    it('accepts a well-formed envelope', () => {
        expect(DsseEnvelope.safeParse(valid).success).toBe(true);
        expect(DsseEnvelope.safeParse({ ...valid, payload: '' }).success).toBe(true);
    });

    it.each([
        ['payload in base64url', { ...valid, payload: '-_-_' }],
        ['payload without padding', { ...valid, payload: 'e30' }],
        ['payload with whitespace', { ...valid, payload: 'e30 =' }],
        ['payload with a trailing newline', { ...valid, payload: 'e30=\n' }],
        ['payload with non-zero trailing bits', { ...valid, payload: 'e31=' }],
        ['sig in base64url', withSig({ sig: encodeBase64Url(new Uint8Array(64).fill(0xfb)) })],
        ['sig without padding', withSig({ sig: SIG.replace(/=+$/, '') })],
        ['sig with whitespace', withSig({ sig: ` ${SIG}` })],
        ['sig with non-zero trailing bits', withSig({ sig: `${SIG.slice(0, -3)}B==` })],
        ['sig of 63 bytes', withSig({ sig: encodeBase64Std(new Uint8Array(63)) })],
        ['sig of 65 bytes', withSig({ sig: encodeBase64Std(new Uint8Array(65)) })],
        ['keyid with padding', withSig({ keyid: `${KEY_ID}=` })],
        ['keyid of 31 bytes', withSig({ keyid: encodeBase64Url(new Uint8Array(31)) })],
        [
            'keyid in the standard alphabet',
            withSig({ keyid: encodeBase64Url(new Uint8Array(32).fill(0xfb)).replace(/-/g, '+').replace(/_/g, '/') }),
        ],
        ['no signatures', { ...valid, signatures: [] }],
        ['17 signatures', { ...valid, signatures: Array.from({ length: 17 }, () => ({ keyid: KEY_ID, sig: SIG })) }],
        ['an unknown top-level field', { ...valid, extra: 1 }],
        ['an unknown signature field', withSig({ extra: 1 })],
        ['an empty payloadType', { ...valid, payloadType: '' }],
        ['a control character in payloadType', { ...valid, payloadType: 'application/x\n' }],
        ['a non-ASCII payloadType', { ...valid, payloadType: 'application/é' }],
        ['a missing payload', { payloadType: valid.payloadType, signatures: valid.signatures }],
    ])('rejects %s', (_, envelope) => {
        expect(DsseEnvelope.safeParse(envelope).success).toBe(false);
    });

    // Encodes and parses two maximum-size payloads, which takes seconds when every package's tests share the runner.
    it('rejects a payload over DSSE_MAX_PAYLOAD_BYTES', { timeout: 30_000 }, () => {
        const atLimit = encodeBase64Std(new Uint8Array(DSSE_MAX_PAYLOAD_BYTES));
        const over = encodeBase64Std(new Uint8Array(DSSE_MAX_PAYLOAD_BYTES + 3));
        expect(DsseEnvelope.safeParse({ ...valid, payload: atLimit }).success).toBe(true);
        expect(DsseEnvelope.safeParse({ ...valid, payload: over }).success).toBe(false);
    });
});

describe('pae', () => {
    it('uses UTF-8 byte lengths', () => {
        const encoded = pae('tépe', utf8Encode('é'));
        expect(new TextDecoder().decode(encoded)).toBe('DSSEv1 5 tépe 2 é');
    });

    it('encodes an empty payload', () => {
        expect(toHex(pae('t', new Uint8Array()))).toBe(toHex(utf8Encode('DSSEv1 1 t 0 ')));
    });
});

describe('dsseKeyId', () => {
    it('refuses a key that is not 32 bytes', async () => {
        await expect(dsseKeyId(new Uint8Array(31))).rejects.toThrow(RangeError);
    });
});

describe('verifyDsseSignatures', () => {
    const payload = utf8Encode('{"v":1}');

    async function setup() {
        const keys = await releaseTestKeys();
        const releaseId = await dsseKeyId(keys.release.publicKey());
        return { keys, releaseId, trusted: [keys.release.publicKey()] };
    }

    it('accepts a signature over the PAE', async () => {
        const { keys, releaseId, trusted } = await setup();
        const envelope = await signDsse(keys.release, RELEASE_PAYLOAD_TYPE, payload);
        expect([...(await verifyDsseSignatures(envelope, trusted))]).toEqual([releaseId]);
    });

    it('fails when one payload byte changes', async () => {
        const { keys, trusted } = await setup();
        const envelope = await signDsse(keys.release, RELEASE_PAYLOAD_TYPE, payload);
        const altered = { ...envelope, payload: encodeBase64Std(utf8Encode('{"v":2}')) };
        expect((await verifyDsseSignatures(altered, trusted)).size).toBe(0);
    });

    it('fails when the payload type changes', async () => {
        const { keys, trusted } = await setup();
        const envelope = await signDsse(keys.release, RELEASE_PAYLOAD_TYPE, payload);
        expect((await verifyDsseSignatures({ ...envelope, payloadType: REVOCATION_PAYLOAD_TYPE }, trusted)).size).toBe(
            0,
        );
    });

    it('fails for a signature over the raw payload instead of the PAE', async () => {
        const { keys, releaseId, trusted } = await setup();
        const sig = await keys.release.sign(payload);
        const envelope = DsseEnvelope.parse({
            payloadType: RELEASE_PAYLOAD_TYPE,
            payload: encodeBase64Std(payload),
            signatures: [{ keyid: releaseId, sig: encodeBase64Std(sig) }],
        });
        expect((await verifyDsseSignatures(envelope, trusted)).size).toBe(0);
    });

    it('ignores signatures by unknown keys', async () => {
        const { keys, releaseId, trusted } = await setup();
        const envelope = await signDsse(
            [keys.outsider, keys.release, keys.maintainers[0]],
            RELEASE_PAYLOAD_TYPE,
            payload,
        );
        expect([...(await verifyDsseSignatures(envelope, trusted))]).toEqual([releaseId]);
    });

    it('counts a key that signed twice once', async () => {
        const { keys, releaseId, trusted } = await setup();
        const envelope = await signDsse([keys.release, keys.release], RELEASE_PAYLOAD_TYPE, payload);
        expect(envelope.signatures).toHaveLength(2);
        expect([...(await verifyDsseSignatures(envelope, [...trusted, ...trusted]))]).toEqual([releaseId]);
    });

    it('counts a key whose first signature is invalid and second valid', async () => {
        const { keys, releaseId, trusted } = await setup();
        const envelope = await signDsse(keys.release, RELEASE_PAYLOAD_TYPE, payload);
        const bad = { keyid: releaseId, sig: encodeBase64Std(new Uint8Array(64)) };
        const doubled = { ...envelope, signatures: [bad, ...envelope.signatures] };
        expect([...(await verifyDsseSignatures(doubled, trusted))]).toEqual([releaseId]);
    });

    it('never throws on a malformed signature and does not count it', async () => {
        const { releaseId, trusted } = await setup();
        const envelope = DsseEnvelope.parse({
            payloadType: RELEASE_PAYLOAD_TYPE,
            payload: encodeBase64Std(payload),
            signatures: [
                { keyid: releaseId, sig: encodeBase64Std(new Uint8Array(64)) },
                { keyid: releaseId, sig: encodeBase64Std(new Uint8Array(64).fill(0xff)) },
            ],
        });
        expect((await verifyDsseSignatures(envelope, trusted)).size).toBe(0);
    });

    it('does not count a signature by key B filed under key A', async () => {
        const { keys, releaseId, trusted } = await setup();
        const envelope = await signDsse(keys.maintainers[0], RELEASE_PAYLOAD_TYPE, payload);
        const misfiled = { ...envelope, signatures: envelope.signatures.map(({ sig }) => ({ keyid: releaseId, sig })) };
        expect((await verifyDsseSignatures(misfiled, trusted)).size).toBe(0);
    });

    it('verifies independently of WebCrypto with noble', async () => {
        const { keys } = await setup();
        const envelope = await signDsse(keys.release, RELEASE_PAYLOAD_TYPE, payload);
        const sig = Uint8Array.from(atob(envelope.signatures[0]?.sig ?? ''), (char) => char.charCodeAt(0));
        expect(ed25519.verify(sig, pae(RELEASE_PAYLOAD_TYPE, payload), keys.release.publicKey())).toBe(true);
    });
});

describe('signDsse', () => {
    it('produces one signature per signer, in order', async () => {
        const keys = await releaseTestKeys();
        const signers = [keys.release, keys.maintainers[2], keys.maintainers[0]];
        const envelope = await signDsse(signers, RELEASE_PAYLOAD_TYPE, utf8Encode('x'));
        expect(envelope.signatures.map(({ keyid }) => keyid)).toEqual(
            await Promise.all(signers.map((signer) => dsseKeyId(signer.publicKey()))),
        );
        expect(envelope.payload).toBe(encodeBase64Std(utf8Encode('x')));
    });

    it('rejects with an aborted signal', async () => {
        const keys = await releaseTestKeys();
        const controller = new AbortController();
        controller.abort();
        await expect(
            signDsse(keys.release, RELEASE_PAYLOAD_TYPE, utf8Encode('x'), controller.signal),
        ).rejects.toThrow();
    });
});
