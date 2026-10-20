import { describe, expect, it } from 'vitest';
import { encodeBase64Std } from '../base64std';
import { utf8Encode } from '../bytes';
import type { Signer } from '../ed25519';
import { fromHex, toHex } from '../testing/hex';
import { releaseTestKeys } from '../testing/release';
import type { ReleaseTestKeys } from '../testing/release';
import { DsseEnvelope, dsseKeyId, pae, signDsse, verifyDsseSignatures } from './dsse';
import vectors from './vectors.json';

const signed = [
    ['regular', vectors.regular],
    ['security', vectors.security],
    ['revocations', vectors.revocations],
] as const;

const allKeys = vectors.keys.map(({ publicKeyHex }) => fromHex(publicKeyHex));

function signerFor(keys: ReleaseTestKeys, keyid: string) {
    const role = vectors.keys.find((key) => key.keyid === keyid)?.role;
    const signers: Record<string, Signer> = {
        release: keys.release,
        'maintainer-1': keys.maintainers[0],
        'maintainer-2': keys.maintainers[1],
        'maintainer-3': keys.maintainers[2],
    };
    const signer = role === undefined ? undefined : signers[role];
    if (signer === undefined) throw new Error(`no signer for ${keyid}`);
    return signer;
}

describe('release golden vectors', () => {
    it('reproduces the DSSE specification PAE example', () => {
        const encoded = pae(vectors.pae.payloadType, utf8Encode(vectors.pae.payload));
        expect(new TextDecoder().decode(encoded)).toBe(vectors.pae.pae);
    });

    it.each(vectors.keys)('derives the checked-in key ID of the $role key', async ({ publicKeyHex, keyid }) => {
        expect(await dsseKeyId(fromHex(publicKeyHex))).toBe(keyid);
    });

    describe.each(signed)('%s', (_, vector) => {
        const payload = fromHex(vector.payloadHex);

        it('has the payload bytes of the payload text', () => {
            expect(toHex(utf8Encode(vector.payloadText))).toBe(vector.payloadHex);
        });

        it('builds the PAE byte for byte', () => {
            expect(toHex(pae(vector.payloadType, payload))).toBe(vector.paeHex);
        });

        it('encodes the payload as the envelope does', () => {
            const envelope = JSON.parse(vector.envelope) as { payload: string };
            expect(encodeBase64Std(payload)).toBe(envelope.payload);
        });

        it('signs into the exact envelope text with the fixed keys', async () => {
            const keys = await releaseTestKeys();
            const signers = vector.signatures.map(({ keyid }) => signerFor(keys, keyid));
            expect(JSON.stringify(await signDsse(signers, vector.payloadType, payload))).toBe(vector.envelope);
        });

        it('parses and verifies exactly the expected key IDs', async () => {
            const envelope = DsseEnvelope.parse(JSON.parse(vector.envelope));
            const valid = await verifyDsseSignatures(envelope, allKeys);
            expect([...valid].sort()).toEqual(vector.signatures.map(({ keyid }) => keyid).sort());
        });
    });

    it('does not accept a signature over the raw payload instead of the PAE', async () => {
        const envelope = DsseEnvelope.parse(JSON.parse(vectors.signatureOverRawPayload.envelope));
        expect((await verifyDsseSignatures(envelope, allKeys)).size).toBe(0);
    });
});
