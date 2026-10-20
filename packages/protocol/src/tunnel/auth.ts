import { decodeBase64Url } from '../base64url';
import type { Bytes } from '../bytes';
import type { Signer } from '../ed25519';
import { verifyEd25519 } from '../ed25519';
import { deriveEngineId } from '../engine-id';
import type { EngineId, EngineVersion } from '../ids';
import { ed25519SignatureFromBytes, ed25519SignatureToBytes } from '../ids';
import { SIGNING_CONTEXT, signingInput } from '../signing-input';
import { MAX_PROTOCOL_VERSION } from './constants';
import type { TunnelAuth, TunnelChallenge, TunnelFeature } from './handshake';
import { TunnelAuth as TunnelAuthSchema, compareFeatures } from './handshake';

export interface EngineTunnelOffer {
    readonly version: EngineVersion;
    readonly versions: readonly number[];
    readonly features: readonly TunnelFeature[];
}

function assertUnique(list: readonly unknown[]): void {
    // The schemas reject duplicates; one here would make two different lists sign alike.
    if (new Set(list).size !== list.length) throw new RangeError('duplicate entry in a signed list');
}

/** `[2, 10, 1]` → `"1,2,10"`: numeric order, decimal, comma-joined; the empty list is the empty string. */
function encodeVersions(versions: readonly number[]): string {
    assertUnique(versions);
    if (!versions.every((version) => Number.isInteger(version) && version >= 1 && version <= MAX_PROTOCOL_VERSION)) {
        throw new RangeError('protocol version out of range');
    }
    return [...versions].sort((a, b) => a - b).join(',');
}

/** Byte order (`"a-b"` before `"ab"`), comma-joined; the empty list is the empty string. */
function encodeFeatures(features: readonly TunnelFeature[]): string {
    assertUnique(features);
    return [...features].sort(compareFeatures).join(',');
}

function nonceBytes(challenge: TunnelChallenge): Bytes {
    const decoded = decodeBase64Url(challenge.nonce);
    // Unreachable for a parsed challenge; kept so a forged brand (a cast) fails loudly.
    if (decoded.kind === 'invalid') throw new TypeError('nonce is not base64url');
    return decoded.bytes;
}

/**
 * `signingInput('ptbk-tunnel-v1', relayId, nonce, engineId, version, relayVersions, relayFeatures, engineVersions,
 * engineFeatures)` (ADR 0014). The nonce goes in as its raw 32 bytes; each list is one part in canonical order, so the
 * input is the same for lists given in any order. Throws on a duplicate or out-of-range entry, which parsed messages
 * never contain.
 */
export function tunnelAuthInput(challenge: TunnelChallenge, engineId: EngineId, engine: EngineTunnelOffer): Bytes {
    return signingInput(
        SIGNING_CONTEXT.tunnel,
        challenge.relayId,
        nonceBytes(challenge),
        engineId,
        engine.version,
        encodeVersions(challenge.protocolVersions),
        encodeFeatures(challenge.features),
        encodeVersions(engine.versions),
        encodeFeatures(engine.features),
    );
}

export interface TunnelAuthOffer {
    readonly version: EngineVersion;
    readonly protocolVersions: readonly number[];
    readonly features: readonly TunnelFeature[];
}

/**
 * Engine side: builds the whole `auth` message for `challenge`, with the engine ID derived from the signer's key.
 * The caller must first check that `challenge.relayId` is the relay hostname it dialled, so the signature cannot be
 * used at another relay. Throws (a ZodError) if the offer would not pass the `auth` schema.
 */
export async function signTunnelAuth(
    signer: Signer,
    challenge: TunnelChallenge,
    offer: TunnelAuthOffer,
    signal?: AbortSignal,
): Promise<TunnelAuth> {
    const engineId = await deriveEngineId(signer.publicKey());
    const unsigned = TunnelAuthSchema.omit({ sig: true }).parse({
        v: 1,
        type: 'auth',
        engineId,
        version: offer.version,
        protocolVersions: [...offer.protocolVersions],
        features: [...offer.features],
    });
    const input = tunnelAuthInput(challenge, engineId, {
        version: unsigned.version,
        versions: unsigned.protocolVersions,
        features: unsigned.features,
    });
    return { ...unsigned, sig: ed25519SignatureFromBytes(await signer.sign(input, signal)) };
}

/**
 * Relay side. `challenge` must be the one this relay sent, never values echoed by the engine, and `publicKey` the
 * registry's key for `auth.engineId`. Never throws.
 */
export function verifyTunnelAuth(publicKey: Bytes, challenge: TunnelChallenge, auth: TunnelAuth): boolean {
    try {
        const input = tunnelAuthInput(challenge, auth.engineId, {
            version: auth.version,
            versions: auth.protocolVersions,
            features: auth.features,
        });
        return verifyEd25519(publicKey, input, ed25519SignatureToBytes(auth.sig));
    } catch {
        return false;
    }
}
