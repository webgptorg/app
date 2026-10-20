import { z } from 'zod';

import type { Bytes } from './bytes';
import type { Signer } from './ed25519';
import { verifyEd25519 } from './ed25519';
import { defaultHostname, deriveEngineId } from './engine-id';
import {
    Ed25519PublicKey,
    Ed25519Signature,
    EngineId,
    EngineVersion,
    Hostname,
    ed25519PublicKeyFromBytes,
    ed25519PublicKeyToBytes,
    ed25519SignatureFromBytes,
    ed25519SignatureToBytes,
} from './ids';
import { LinkCode } from './link-code';
import { SIGNING_CONTEXT, signingInput } from './signing-input';

export const REGISTER_PATH = '/v1/engines/register';
export const REGISTER_REQUEST_MAX_BYTES = 4096;
export const REGISTER_RESPONSE_MAX_BYTES = 8192;
export const MAX_RELAYS = 16;

/** Local engines never register, so there is no `local` here. */
export const RegistrationMode = z.enum(['tunnel', 'direct']);
export type RegistrationMode = z.infer<typeof RegistrationMode>;

export const RegisterEngineRequest = z.strictObject({
    v: z.literal(1),
    linkCode: LinkCode,
    enginePublicKey: Ed25519PublicKey,
    engineVersion: EngineVersion,
    mode: RegistrationMode,
    sig: Ed25519Signature,
});
export type RegisterEngineRequest = z.infer<typeof RegisterEngineRequest>;

export interface UnsignedRegistration {
    readonly linkCode: LinkCode;
    readonly engineVersion: EngineVersion;
    readonly mode: RegistrationMode;
}

const responseShape = {
    engineId: EngineId,
    hostname: Hostname,
    relays: z
        .array(Hostname)
        .min(1)
        .max(MAX_RELAYS)
        .refine((relays) => new Set(relays).size === relays.length, 'relays must be unique'),
};

/** As the dashboard sends it. */
export const RegisterEngineResponse = z.strictObject(responseShape);
export type RegisterEngineResponse = z.infer<typeof RegisterEngineResponse>;

/** What the engine parses the response with: known fields validated, unknown ones stripped (ADR 0010 §3). */
export const TolerantRegisterEngineResponse = z.object(responseShape);

function registrationInput(
    request: UnsignedRegistration & { readonly v: 1; readonly enginePublicKey: Ed25519PublicKey },
): Bytes {
    return signingInput(
        SIGNING_CONTEXT.register,
        String(request.v),
        request.linkCode,
        ed25519PublicKeyToBytes(request.enginePublicKey),
        request.engineVersion,
        request.mode,
    );
}

/**
 * Proof of key possession: signs `signingInput('ptbk-register-v1', "1", linkCode, raw public key, engineVersion, mode)`
 * with the engine key, so a stolen link code cannot register someone else's key and `mode` cannot be flipped in transit.
 */
export async function signRegistration(
    signer: Signer,
    registration: UnsignedRegistration,
    signal?: AbortSignal,
): Promise<RegisterEngineRequest> {
    const unsigned = {
        v: 1 as const,
        linkCode: registration.linkCode,
        enginePublicKey: ed25519PublicKeyFromBytes(signer.publicKey()),
        engineVersion: registration.engineVersion,
        mode: registration.mode,
    };
    const signature = await signer.sign(registrationInput(unsigned), signal);
    return { ...unsigned, sig: ed25519SignatureFromBytes(signature) };
}

/** Checks `sig` against the request's own `enginePublicKey`. Takes a request that already passed the strict schema. */
export function verifyRegistration(request: RegisterEngineRequest): boolean {
    return verifyEd25519(
        ed25519PublicKeyToBytes(request.enginePublicKey),
        registrationInput(request),
        ed25519SignatureToBytes(request.sig),
    );
}

export type RegistrationResponseCheck =
    { readonly kind: 'ok' } | { readonly kind: 'engine-id-mismatch' } | { readonly kind: 'hostname-mismatch' };

/** The engine refuses a dashboard that hands it an identity its own key does not derive. */
export async function checkRegistrationResponse(
    response: RegisterEngineResponse,
    publicKey: Bytes,
    engineDomain: Hostname,
): Promise<RegistrationResponseCheck> {
    const engineId = await deriveEngineId(publicKey);
    if (response.engineId !== engineId) return { kind: 'engine-id-mismatch' };
    if (response.hostname !== defaultHostname(engineId, engineDomain)) return { kind: 'hostname-mismatch' };
    return { kind: 'ok' };
}
