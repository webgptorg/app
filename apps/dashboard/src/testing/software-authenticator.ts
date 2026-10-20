import { isoCBOR } from '@simplewebauthn/server/helpers';

import { fromBase64Url, toBase64Url } from '../domain/auth/secrets';
import type {
    AuthenticationOptions,
    AuthenticationResponse,
    RegistrationOptions,
    RegistrationResponse,
} from '../shared/api/webauthn';

/**
 * A WebAuthn authenticator in software (ES256, `none` attestation) for tests: it builds the exact bytes a browser and
 * a platform authenticator would, so the real `@simplewebauthn/server` verification runs end to end. Overrides forge
 * what an attacker or a broken authenticator could send.
 */

export interface SoftwareCredential {
    readonly id: Uint8Array;
    readonly keys: CryptoKeyPair;
    readonly userHandle: Uint8Array;
    readonly rpId: string;
    counter: number;
}

export interface CeremonyOverrides {
    readonly origin?: string;
    readonly rpId?: string;
    readonly challenge?: string;
    readonly userVerified?: boolean;
    readonly type?: string;
}

export interface RegistrationOverrides extends CeremonyOverrides {
    /** Register this credential's ID and key again, as a second account or a replaying client would. */
    readonly reuse?: SoftwareCredential;
}

export interface AssertionOverrides extends CeremonyOverrides {
    readonly credentialId?: string;
    /** A different user handle, or null to send none. */
    readonly userHandle?: string | null;
    /** The signature counter to report instead of the authenticator's own. */
    readonly counter?: number;
    /** Sign with this credential's key while claiming `credentialId`: a forged assertion. */
    readonly signWith?: SoftwareCredential;
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function uint32(value: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value);
    return out;
}

/** WebCrypto signs ECDSA as raw r ‖ s; WebAuthn carries ASN.1 DER. */
function derSignature(raw: Uint8Array): Uint8Array {
    const integer = (bytes: Uint8Array) => {
        let start = 0;
        while (start < bytes.length - 1 && bytes[start] === 0) {
            start++;
        }
        const trimmed = bytes.slice(start);
        const padded = (trimmed[0] ?? 0) & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed;
        return concat(new Uint8Array([0x02, padded.length]), padded);
    };
    const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
    return concat(new Uint8Array([0x30, body.length]), body);
}

function clientData(type: string, challenge: string, origin: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
}

export function createSoftwareAuthenticator(config: {
    readonly origin: string;
    /** How much the signature counter grows per assertion; 0 behaves like a synced passkey. */
    readonly counterStep?: number;
}) {
    const credentials: SoftwareCredential[] = [];
    const counterStep = config.counterStep ?? 1;

    function flags(userVerified: boolean | undefined, extra: number): Uint8Array {
        return new Uint8Array([FLAG_USER_PRESENT | (userVerified === false ? 0 : FLAG_USER_VERIFIED) | extra]);
    }

    return {
        credentials,

        async register(
            options: RegistrationOptions,
            overrides: RegistrationOverrides = {},
        ): Promise<RegistrationResponse> {
            const keys =
                overrides.reuse?.keys ??
                ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
                    'sign',
                    'verify',
                ])) as CryptoKeyPair);
            const raw = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
            const credentialId = overrides.reuse?.id ?? crypto.getRandomValues(new Uint8Array(16));
            const rpId = overrides.rpId ?? options.rp.id;
            const credential: SoftwareCredential = {
                id: credentialId,
                keys,
                userHandle: fromBase64Url(options.user.id),
                rpId,
                counter: 0,
            };
            const cosePublicKey = isoCBOR.encode(
                new Map<number, number | Uint8Array>([
                    [1, 2],
                    [3, -7],
                    [-1, 1],
                    [-2, raw.slice(1, 33)],
                    [-3, raw.slice(33, 65)],
                ]),
            );
            const authData = concat(
                await sha256(Uint8Array.from(new TextEncoder().encode(rpId))),
                flags(overrides.userVerified, FLAG_ATTESTED_DATA),
                uint32(credential.counter),
                new Uint8Array(16),
                new Uint8Array([0, credentialId.length]),
                credentialId,
                cosePublicKey,
            );
            const attestationObject = isoCBOR.encode(
                new Map<string, string | Uint8Array | Map<string, never>>([
                    ['fmt', 'none'],
                    ['attStmt', new Map<string, never>()],
                    ['authData', authData],
                ]),
            );
            credentials.push(credential);
            const id = toBase64Url(credentialId);
            return {
                id,
                rawId: id,
                type: 'public-key',
                response: {
                    clientDataJSON: toBase64Url(
                        clientData(
                            overrides.type ?? 'webauthn.create',
                            overrides.challenge ?? options.challenge,
                            overrides.origin ?? config.origin,
                        ),
                    ),
                    attestationObject: toBase64Url(attestationObject),
                    transports: ['internal'],
                },
                authenticatorAttachment: 'platform',
                clientExtensionResults: { credProps: { rk: true } },
            };
        },

        async assert(
            options: AuthenticationOptions,
            overrides: AssertionOverrides = {},
        ): Promise<AuthenticationResponse> {
            const allowed = options.allowCredentials.map((descriptor) => descriptor.id);
            const credential =
                overrides.signWith ??
                credentials.find((candidate) => {
                    const id = toBase64Url(candidate.id);
                    return overrides.credentialId === undefined
                        ? candidate.rpId === options.rpId && (allowed.length === 0 || allowed.includes(id))
                        : id === overrides.credentialId;
                }) ??
                // Claiming an ID the authenticator never had: sign with the first key it holds.
                (overrides.credentialId === undefined ? undefined : credentials[0]);
            if (credential === undefined) {
                throw new Error('the software authenticator has no matching credential');
            }
            credential.counter += counterStep;
            const data = clientData(
                overrides.type ?? 'webauthn.get',
                overrides.challenge ?? options.challenge,
                overrides.origin ?? config.origin,
            );
            const authData = concat(
                await sha256(Uint8Array.from(new TextEncoder().encode(overrides.rpId ?? options.rpId))),
                flags(overrides.userVerified, 0),
                uint32(overrides.counter ?? credential.counter),
            );
            const signed = concat(authData, await sha256(data));
            const signature = new Uint8Array(
                await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, credential.keys.privateKey, signed),
            );
            const id = overrides.credentialId ?? toBase64Url(credential.id);
            const userHandle =
                overrides.userHandle === undefined ? toBase64Url(credential.userHandle) : overrides.userHandle;
            return {
                id,
                rawId: id,
                type: 'public-key',
                response: {
                    clientDataJSON: toBase64Url(data),
                    authenticatorData: toBase64Url(authData),
                    signature: toBase64Url(derSignature(signature)),
                    ...(userHandle === null ? {} : { userHandle }),
                },
                authenticatorAttachment: 'platform',
                clientExtensionResults: {},
            };
        },
    };
}

export type SoftwareAuthenticator = ReturnType<typeof createSoftwareAuthenticator>;
