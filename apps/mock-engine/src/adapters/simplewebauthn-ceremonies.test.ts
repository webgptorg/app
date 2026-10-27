import { describe, expect, it } from 'vitest';

import type { RelyingParty } from '../domain/gateway/passkey-ceremonies';
import { createSimpleWebAuthnCeremonies } from './simplewebauthn-ceremonies';

const RP: RelyingParty = { id: 'engine.ptbk.test', origin: 'https://engine.ptbk.test' };
const CREDENTIAL = {
    credentialId: 'Y3JlZGVudGlhbA',
    publicKey: 'cHVibGljLWtleQ',
    counter: 0,
    transports: [],
    attachment: null,
    backedUp: false,
};

// The happy path needs a real authenticator; the browser test drives one. These are the refusals.
describe('createSimpleWebAuthnCeremonies', () => {
    const ceremonies = createSimpleWebAuthnCeremonies();

    it('asks for a discoverable passkey with user verification, for this RP and challenge only', async () => {
        const options = (await ceremonies.registrationOptions({
            rp: RP,
            rpName: 'Promptbook engine',
            userHandle: 'dXNlci1oYW5kbGU',
            userName: 'Owner',
            challenge: 'Y2hhbGxlbmdl',
            excludeCredentialIds: [],
        })) as Record<string, unknown>;
        expect(options).toMatchObject({
            rp: { id: RP.id, name: 'Promptbook engine' },
            challenge: 'Y2hhbGxlbmdl',
            attestation: 'none',
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        });
        const request = (await ceremonies.authenticationOptions({
            rp: RP,
            challenge: 'Y2hhbGxlbmdl',
            allowCredentialIds: null,
        })) as Record<string, unknown>;
        expect(request).toMatchObject({ rpId: RP.id, challenge: 'Y2hhbGxlbmdl', userVerification: 'required' });
        expect(request['allowCredentials']).toBeUndefined();
    });

    it('answers null for anything that is not a well-formed response, without touching the challenge', async () => {
        let asked = 0;
        const expectChallenge = (): boolean => {
            asked++;
            return true;
        };
        for (const response of [null, 'x', { id: 'a' }, { id: 'a', rawId: 'a', type: 'public-key', extra: 1 }]) {
            expect(await ceremonies.verifyRegistration({ rp: RP, response, expectChallenge })).toBeNull();
            expect(ceremonies.credentialIdOf(response)).toBeNull();
            expect(
                await ceremonies.verifyAuthentication({ rp: RP, response, credential: CREDENTIAL, expectChallenge }),
            ).toBeNull();
        }
        expect(asked).toBe(0);
    });

    it('answers null for a well-formed response that does not verify', async () => {
        const clientData = Buffer.from(
            JSON.stringify({ type: 'webauthn.get', challenge: 'Y2hhbGxlbmdl', origin: RP.origin }),
        ).toString('base64url');
        const response = {
            id: CREDENTIAL.credentialId,
            rawId: CREDENTIAL.credentialId,
            type: 'public-key',
            clientExtensionResults: {},
            response: { clientDataJSON: clientData, authenticatorData: 'AAAA', signature: 'AAAA' },
        };
        expect(ceremonies.credentialIdOf(response)).toBe(CREDENTIAL.credentialId);
        expect(
            await ceremonies.verifyAuthentication({
                rp: RP,
                response,
                credential: CREDENTIAL,
                expectChallenge: () => true,
            }),
        ).toBeNull();
        expect(
            await ceremonies.verifyAuthentication({
                rp: RP,
                response: { ...response, id: 'b3RoZXI', rawId: 'b3RoZXI' },
                credential: CREDENTIAL,
                expectChallenge: () => true,
            }),
        ).toBeNull();
    });
});
