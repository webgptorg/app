import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from './base64url';
import { utf8Encode } from './bytes';
import { defaultHostname } from './engine-id';
import { EngineVersion, Hostname, ed25519PublicKeyFromBytes, ed25519SignatureFromBytes } from './ids';
import { LinkCode } from './link-code';
import type { RegisterEngineRequest, UnsignedRegistration } from './registration';
import {
    MAX_RELAYS,
    REGISTER_PATH,
    REGISTER_REQUEST_MAX_BYTES,
    REGISTER_RESPONSE_MAX_BYTES,
    RegisterEngineRequest as RegisterEngineRequestSchema,
    RegisterEngineResponse,
    TolerantRegisterEngineResponse,
    checkRegistrationResponse,
    signRegistration,
    verifyRegistration,
} from './registration';
import vectors from './signed-message-vectors.json';
import { signingInput } from './signing-input';
import { toHex } from './testing/hex';
import { freshIdentity, vectorIdentity } from './testing/signers';

const engineDomain = Hostname.parse('engines.example');
const unsigned: UnsignedRegistration = {
    linkCode: LinkCode.parse('aaaqeayeaudaocajbifqydiob4'),
    engineVersion: EngineVersion.parse('1.8.2'),
    mode: 'tunnel',
};

async function signedRequest(): Promise<RegisterEngineRequest> {
    return signRegistration((await freshIdentity()).signer, unsigned);
}

describe('registration golden vector (src/signed-message-vectors.json)', () => {
    it('reproduces the independently computed request and signing input', async () => {
        const { signer, publicKey } = await vectorIdentity();
        expect(toHex(publicKey)).toBe(vectors.key.publicKeyHex);
        const request = await signRegistration(signer, unsigned);
        expect(request).toEqual(vectors.registration.request);
        const input = signingInput('ptbk-register-v1', '1', unsigned.linkCode, publicKey, '1.8.2', 'tunnel');
        expect(toHex(input)).toBe(vectors.registration.signingInputHex);
    });

    it('parses and verifies the vector', () => {
        const request = RegisterEngineRequestSchema.parse(vectors.registration.request);
        expect(verifyRegistration(request)).toBe(true);
    });
});

describe('verifyRegistration', () => {
    it('verifies a request it signed, with the key taken from the signer', async () => {
        const { signer, publicKey } = await freshIdentity();
        const request = await signRegistration(signer, unsigned);
        expect(request.v).toBe(1);
        expect(request.enginePublicKey).toBe(ed25519PublicKeyFromBytes(publicKey));
        expect(verifyRegistration(request)).toBe(true);
    });

    it('rejects a valid link code with a signature from a different key', async () => {
        const request = await signedRequest();
        const other = await signedRequest();
        expect(verifyRegistration({ ...request, sig: other.sig })).toBe(false);
        expect(verifyRegistration({ ...request, enginePublicKey: other.enginePublicKey })).toBe(false);
    });

    it.each<[string, Partial<RegisterEngineRequest>]>([
        ['engineVersion', { engineVersion: EngineVersion.parse('1.8.3') }],
        ['mode', { mode: 'direct' }],
        ['linkCode', { linkCode: LinkCode.parse('aaaqeayeaudaocajbifqydioba') }],
    ])('rejects a request whose %s changed after signing', async (_, change) => {
        expect(verifyRegistration({ ...(await signedRequest()), ...change })).toBe(false);
    });

    it('rejects a signature over the base64url text of the key instead of its raw bytes', async () => {
        const { signer } = await freshIdentity();
        const request = await signRegistration(signer, unsigned);
        const textInput = signingInput(
            'ptbk-register-v1',
            '1',
            unsigned.linkCode,
            request.enginePublicKey,
            '1.8.2',
            'tunnel',
        );
        const sig = ed25519SignatureFromBytes(await signer.sign(textInput));
        expect(verifyRegistration({ ...request, sig })).toBe(false);
    });

    it('rejects the same parts signed under another context, and a heartbeat signature replayed here', async () => {
        const { signer, publicKey } = await freshIdentity();
        const request = await signRegistration(signer, unsigned);
        const parts = ['1', unsigned.linkCode, publicKey, '1.8.2', 'tunnel'] as const;
        for (const context of ['ptbk-heartbeat-v1', 'ptbk-hostname-v1', 'ptbk-tunnel-v1'] as const) {
            const sig = ed25519SignatureFromBytes(await signer.sign(signingInput(context, ...parts)));
            expect(verifyRegistration({ ...request, sig })).toBe(false);
        }
    });

    it('rejects v sent as raw bytes instead of its decimal string', async () => {
        const { signer, publicKey } = await freshIdentity();
        const request = await signRegistration(signer, unsigned);
        const input = signingInput(
            'ptbk-register-v1',
            Uint8Array.of(1),
            unsigned.linkCode,
            publicKey,
            '1.8.2',
            'tunnel',
        );
        expect(verifyRegistration({ ...request, sig: ed25519SignatureFromBytes(await signer.sign(input)) })).toBe(
            false,
        );
    });

    it('rejects a forged signature', async () => {
        const request = await signedRequest();
        const bytes = new Uint8Array(64).fill(7);
        expect(verifyRegistration({ ...request, sig: ed25519SignatureFromBytes(bytes) })).toBe(false);
    });

    it('passes the abort signal to the signer', async () => {
        const { signer } = await freshIdentity();
        await expect(signRegistration(signer, unsigned, AbortSignal.abort())).rejects.toThrow();
    });
});

describe('RegisterEngineRequest schema', () => {
    const valid = vectors.registration.request;

    it.each([
        ['an unknown field', { ...valid, orgId: 'org_1' }],
        ['v: 2', { ...valid, v: 2 }],
        ['a missing v', { ...valid, v: undefined }],
        ['mode local', { ...valid, mode: 'local' }],
        ['a missing sig', { ...valid, sig: undefined }],
        ['a padded key', { ...valid, enginePublicKey: `${valid.enginePublicKey}=` }],
        ['a non-SemVer version', { ...valid, engineVersion: 'v1.8' }],
        ['an uppercase link code', { ...valid, linkCode: valid.linkCode.toUpperCase() }],
    ])('rejects %s', (_, value) => {
        expect(RegisterEngineRequestSchema.safeParse(value).success).toBe(false);
    });

    it('fits the largest valid request in REGISTER_REQUEST_MAX_BYTES', () => {
        const largest = { ...valid, engineVersion: `1.0.0-${'a'.repeat(250)}`, mode: 'direct' };
        expect(RegisterEngineRequestSchema.safeParse(largest).success).toBe(true);
        expect(utf8Encode(JSON.stringify(largest)).length).toBeLessThan(REGISTER_REQUEST_MAX_BYTES);
    });

    it('exposes the path', () => {
        expect(REGISTER_PATH).toBe('/v1/engines/register');
    });
});

describe('RegisterEngineResponse', () => {
    const response = {
        engineId: vectors.key.engineId,
        hostname: `${vectors.key.engineId}.engines.example`,
        relays: ['relay-fsn.ptbk.example', 'relay-hel.ptbk.example'],
        memberKey: vectors.registration.request.enginePublicKey,
        ownerSetupCommitment: 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA',
    };

    it('accepts a response with 1 to 16 relays', () => {
        expect(RegisterEngineResponse.parse(response)).toEqual(response);
        const sixteen = Array.from({ length: MAX_RELAYS }, (_, index) => `relay-${String(index)}.ptbk.example`);
        expect(RegisterEngineResponse.safeParse({ ...response, relays: sixteen }).success).toBe(true);
    });

    it.each([
        ['an unknown field', { ...response, orgId: 'org_1' }],
        ['no relays', { ...response, relays: [] }],
        ['a member key of the wrong length', { ...response, memberKey: 'AAAA' }],
        ['a commitment of 31 bytes', { ...response, ownerSetupCommitment: 'A'.repeat(42) }],
        ['a commitment in standard base64', { ...response, ownerSetupCommitment: `${'A'.repeat(42)}+` }],
        ['a commitment with padding', { ...response, ownerSetupCommitment: `${'A'.repeat(43)}=` }],
        [
            '17 relays',
            { ...response, relays: Array.from({ length: 17 }, (_, index) => `r${String(index)}.ptbk.example`) },
        ],
        ['a duplicate relay', { ...response, relays: ['relay-fsn.ptbk.example', 'relay-fsn.ptbk.example'] }],
        [
            'a duplicate relay in another case',
            { ...response, relays: ['relay-fsn.ptbk.example', 'Relay-FSN.ptbk.example'] },
        ],
        ['an IP relay', { ...response, relays: ['192.0.2.1'] }],
        ['an uppercase engine ID', { ...response, engineId: vectors.key.engineId.toUpperCase() }],
    ])('rejects %s', (_, value) => {
        expect(RegisterEngineResponse.safeParse(value).success).toBe(false);
    });

    it('reads a dashboard without teams as having no member key', () => {
        const withoutKey = { engineId: response.engineId, hostname: response.hostname, relays: response.relays };
        expect(RegisterEngineResponse.parse(withoutKey)).toEqual({
            ...withoutKey,
            memberKey: null,
            ownerSetupCommitment: null,
        });
        expect(TolerantRegisterEngineResponse.parse(withoutKey).memberKey).toBeNull();
    });

    it('reads an answer without a handoff as no commitment, and carries one an engine can check', () => {
        const without = { ...response, ownerSetupCommitment: undefined };
        expect(TolerantRegisterEngineResponse.parse(without).ownerSetupCommitment).toBeNull();
        expect(
            RegisterEngineResponse.parse({ ...response, ownerSetupCommitment: null }).ownerSetupCommitment,
        ).toBeNull();
        expect(TolerantRegisterEngineResponse.parse(response).ownerSetupCommitment).toBe(response.ownerSetupCommitment);
        expect(TolerantRegisterEngineResponse.safeParse({ ...response, ownerSetupCommitment: 'x' }).success).toBe(
            false,
        );
    });

    it('is read tolerantly by the engine: unknown fields stripped, known ones still validated', () => {
        expect(TolerantRegisterEngineResponse.parse({ ...response, plan: 'pro' })).toEqual(response);
        expect(TolerantRegisterEngineResponse.safeParse({ ...response, relays: [], plan: 'pro' }).success).toBe(false);
    });

    it('fits the largest valid response in REGISTER_RESPONSE_MAX_BYTES', () => {
        const label = 'a'.repeat(63);
        const relays = Array.from({ length: MAX_RELAYS }, (_, index) =>
            [label, label, label, `${'r'.repeat(51)}${String(index).padStart(2, '0')}`, 'example'].join('.'),
        );
        const domain = [label, label, label, 'd'.repeat(26), 'example'].join('.');
        const largest = { ...response, hostname: `${vectors.key.engineId}.${domain}`, relays };
        expect(RegisterEngineResponse.safeParse(largest).success).toBe(true);
        expect(utf8Encode(JSON.stringify(largest)).length).toBeLessThan(REGISTER_RESPONSE_MAX_BYTES);
    });
});

describe('checkRegistrationResponse', () => {
    it('accepts the identity its own key derives', async () => {
        const { publicKey, engineId } = await freshIdentity();
        const response = RegisterEngineResponse.parse({
            engineId,
            hostname: defaultHostname(engineId, engineDomain),
            relays: ['relay-fsn.ptbk.example'],
        });
        await expect(checkRegistrationResponse(response, publicKey, engineDomain)).resolves.toEqual({ kind: 'ok' });
    });

    it("refuses another engine's ID, even with the matching hostname", async () => {
        const { publicKey } = await freshIdentity();
        const other = await freshIdentity();
        const response = RegisterEngineResponse.parse({
            engineId: other.engineId,
            hostname: defaultHostname(other.engineId, engineDomain),
            relays: ['relay-fsn.ptbk.example'],
        });
        await expect(checkRegistrationResponse(response, publicKey, engineDomain)).resolves.toEqual({
            kind: 'engine-id-mismatch',
        });
    });

    it.each([
        ['another engine', async () => defaultHostname((await freshIdentity()).engineId, engineDomain)],
        ['another engine domain', (engineId: string) => Promise.resolve(`${engineId}.engines.evil`)],
        ['a custom hostname', () => Promise.resolve('agents.customer.com')],
        ['the engine domain itself', () => Promise.resolve('engines.example')],
    ])('refuses a hostname of %s', async (_, hostnameOf) => {
        const { publicKey, engineId } = await freshIdentity();
        const response = RegisterEngineResponse.parse({
            engineId,
            hostname: await hostnameOf(engineId),
            relays: ['relay-fsn.ptbk.example'],
        });
        await expect(checkRegistrationResponse(response, publicKey, engineDomain)).resolves.toEqual({
            kind: 'hostname-mismatch',
        });
    });

    it('throws for a key that is not 32 raw bytes, a bug in the caller', async () => {
        const { publicKey } = await freshIdentity();
        const response = RegisterEngineResponse.parse({
            engineId: vectors.key.engineId,
            hostname: `${vectors.key.engineId}.engines.example`,
            relays: ['relay-fsn.ptbk.example'],
        });
        await expect(
            checkRegistrationResponse(response, utf8Encode(encodeBase64Url(publicKey)), engineDomain),
        ).rejects.toThrow(RangeError);
    });
});
