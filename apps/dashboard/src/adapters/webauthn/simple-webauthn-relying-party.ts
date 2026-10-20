import {
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from '@simplewebauthn/server';

import type { RelyingParty } from '../../domain/ports/relying-party';
import { fromBase64Url } from '../../domain/auth/secrets';
import { registrationOptionsSchema, type AuthenticationOptions } from '../../shared/api/webauthn';

/** Ed25519, ES256, RS256: every passkey provider in use supports at least one; nothing weaker is offered. */
export const SUPPORTED_ALGORITHMS = [-8, -7, -257];
const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * `@simplewebauthn/server` bound to the dashboard origin. rpID is the origin's hostname; both come from config and are
 * never derived from the request. The library throws on any mismatch; every throw is a rejection.
 */
export function createSimpleWebAuthnRelyingParty(config: {
    readonly origin: string;
    readonly rpName: string;
}): RelyingParty {
    const rpID = new URL(config.origin).hostname;
    return {
        async registrationOptions(input) {
            const options = await generateRegistrationOptions({
                rpName: config.rpName,
                rpID,
                userName: input.userName,
                userDisplayName: input.userName,
                userID: Uint8Array.from(input.userHandle),
                // Bytes, not the string: the library would UTF-8 encode a string and send a different challenge.
                challenge: fromBase64Url(input.challenge),
                timeout: CEREMONY_TIMEOUT_MS,
                attestationType: 'none',
                excludeCredentials: input.exclude.map((credential) => ({
                    id: credential.id,
                    transports: [...credential.transports],
                })),
                authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
                supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
            });
            // Parsed so a library upgrade that changes the shape fails here, not in the browser.
            return registrationOptionsSchema.parse(options);
        },

        authenticationOptions(input): AuthenticationOptions {
            return {
                challenge: input.challenge,
                timeout: CEREMONY_TIMEOUT_MS,
                rpId: rpID,
                allowCredentials: input.allow.map((credential) => ({
                    id: credential.id,
                    type: 'public-key',
                    transports: [...credential.transports],
                })),
                userVerification: 'required',
            };
        },

        async verifyRegistration(input) {
            try {
                const result = await verifyRegistrationResponse({
                    response: input.response,
                    expectedChallenge: input.expectedChallenge,
                    expectedOrigin: config.origin,
                    expectedRPID: rpID,
                    requireUserPresence: true,
                    requireUserVerification: true,
                    supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
                });
                if (!result.verified) {
                    return { kind: 'rejected' };
                }
                const { credential, credentialBackedUp } = result.registrationInfo;
                return {
                    kind: 'verified',
                    credential: {
                        id: credential.id,
                        publicKey: Uint8Array.from(credential.publicKey),
                        counter: credential.counter,
                        transports: input.response.response.transports ?? [],
                        backedUp: credentialBackedUp,
                    },
                };
            } catch {
                return { kind: 'rejected' };
            }
        },

        async verifyAuthentication(input) {
            try {
                const result = await verifyAuthenticationResponse({
                    response: input.response,
                    expectedChallenge: input.expectedChallenge,
                    expectedOrigin: config.origin,
                    expectedRPID: rpID,
                    // Counter 0 turns the library's own counter check off; the caller compares and records regressions.
                    credential: {
                        id: input.credential.id,
                        publicKey: Uint8Array.from(input.credential.publicKey),
                        counter: 0,
                    },
                    requireUserVerification: true,
                });
                return result.verified
                    ? { kind: 'verified', newCounter: result.authenticationInfo.newCounter }
                    : { kind: 'rejected' };
            } catch {
                return { kind: 'rejected' };
            }
        },
    };
}
