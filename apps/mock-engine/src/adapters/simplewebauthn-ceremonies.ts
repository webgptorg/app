import { decodeBase64Url, encodeBase64Url } from '@ptbk/protocol';
import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

import type { PasskeyCeremonies } from '../domain/gateway/passkey-ceremonies';

const CEREMONY_TIMEOUT_MS = 120_000;
/** ES256 and EdDSA, then RS256 for Windows Hello: what passkey authenticators make. */
const ALGORITHMS = [-7, -8, -257];

const B64 = (max: number) =>
    z
        .string()
        .regex(/^[A-Za-z0-9_-]*$/)
        .max(max);
const TRANSPORT = z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
const ATTACHMENT = z.enum(['platform', 'cross-platform']);
const EXTENSION_RESULTS = z
    .record(z.string().max(64), z.json())
    .refine((value) => JSON.stringify(value).length <= 2048);

/** The browser's `RegistrationResponseJSON`, as the reference page sends it; anything else is refused unread. */
const RegistrationResponse = z.strictObject({
    id: B64(1024),
    rawId: B64(1024),
    type: z.literal('public-key'),
    authenticatorAttachment: ATTACHMENT.optional(),
    clientExtensionResults: EXTENSION_RESULTS,
    response: z.strictObject({
        clientDataJSON: B64(4096),
        attestationObject: B64(16_384),
        authenticatorData: B64(8192).optional(),
        transports: z.array(TRANSPORT).max(8).optional(),
        publicKeyAlgorithm: z.int().optional(),
        publicKey: B64(4096).optional(),
    }),
});

const AuthenticationResponse = z.strictObject({
    id: B64(1024),
    rawId: B64(1024),
    type: z.literal('public-key'),
    authenticatorAttachment: ATTACHMENT.optional(),
    clientExtensionResults: EXTENSION_RESULTS,
    response: z.strictObject({
        clientDataJSON: B64(4096),
        authenticatorData: B64(8192),
        signature: B64(2048),
        userHandle: B64(256).optional(),
    }),
});

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
    const decoded = decodeBase64Url(text);
    if (decoded.kind !== 'ok') throw new Error('invalid base64url');
    return new Uint8Array(decoded.bytes);
}

/**
 * The WebAuthn port on `@simplewebauthn/server` (catalog version, ADR 0014). Passkeys must be discoverable, so sign-in
 * needs no username, and user verification is required: a passkey stands for the owner, not just for a device in
 * reach. Attestation is not requested; the engine trusts the person holding the setup link, not an authenticator's
 * make. A response that fails to parse or verify, or throws while verifying, is `null`: the gateway answers it the
 * same way whatever went wrong.
 */
export function createSimpleWebAuthnCeremonies(): PasskeyCeremonies {
    return {
        registrationOptions: ({ rp, rpName, userHandle, userName, challenge, excludeCredentialIds }) =>
            generateRegistrationOptions({
                rpName,
                rpID: rp.id,
                userName,
                userDisplayName: userName,
                userID: bytesOf(userHandle),
                // As bytes: a string would be base64url-encoded again, and the browser would sign a challenge the
                // engine never issued.
                challenge: bytesOf(challenge),
                timeout: CEREMONY_TIMEOUT_MS,
                attestationType: 'none',
                excludeCredentials: excludeCredentialIds.map((id) => ({ id })),
                authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
                supportedAlgorithmIDs: ALGORITHMS,
            }),

        async verifyRegistration({ rp, response, expectChallenge }) {
            const parsed = RegistrationResponse.safeParse(response);
            if (!parsed.success) return null;
            try {
                const result = await verifyRegistrationResponse({
                    // The strict schema above is this type, with optional fields that may be absent but never undefined.
                    response: parsed.data as RegistrationResponseJSON,
                    expectedChallenge: expectChallenge,
                    expectedOrigin: rp.origin,
                    expectedRPID: rp.id,
                    requireUserVerification: true,
                    supportedAlgorithmIDs: ALGORITHMS,
                });
                if (!result.verified) return null;
                const { credential, credentialBackedUp } = result.registrationInfo;
                return {
                    credentialId: credential.id,
                    publicKey: encodeBase64Url(credential.publicKey),
                    counter: credential.counter,
                    transports: credential.transports ?? [],
                    attachment: parsed.data.authenticatorAttachment ?? null,
                    backedUp: credentialBackedUp,
                };
            } catch {
                return null;
            }
        },

        authenticationOptions: ({ rp, challenge, allowCredentialIds }) =>
            generateAuthenticationOptions({
                rpID: rp.id,
                challenge: bytesOf(challenge),
                timeout: CEREMONY_TIMEOUT_MS,
                userVerification: 'required',
                ...(allowCredentialIds === null ? {} : { allowCredentials: allowCredentialIds.map((id) => ({ id })) }),
            }),

        credentialIdOf(response) {
            const parsed = AuthenticationResponse.safeParse(response);
            return parsed.success ? parsed.data.id : null;
        },

        async verifyAuthentication({ rp, response, credential, expectChallenge }) {
            const parsed = AuthenticationResponse.safeParse(response);
            if (!parsed.success || parsed.data.id !== credential.credentialId) return null;
            try {
                const result = await verifyAuthenticationResponse({
                    response: parsed.data as AuthenticationResponseJSON,
                    expectedChallenge: expectChallenge,
                    expectedOrigin: rp.origin,
                    expectedRPID: rp.id,
                    requireUserVerification: true,
                    credential: {
                        id: credential.credentialId,
                        publicKey: bytesOf(credential.publicKey),
                        counter: credential.counter,
                        transports: [...credential.transports],
                    },
                });
                if (!result.verified) return null;
                return {
                    counter: result.authenticationInfo.newCounter,
                    backedUp: result.authenticationInfo.credentialBackedUp,
                };
            } catch {
                return null;
            }
        },
    };
}
