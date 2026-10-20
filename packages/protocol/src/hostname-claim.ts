import type { Bytes } from './bytes';
import type { Signer } from './ed25519';
import { verifyEd25519 } from './ed25519';
import type { EngineId, Hostname } from './ids';
import { SIGNING_CONTEXT, signingInput } from './signing-input';

/** The engine's signature that it serves a custom hostname: Ed25519 over `signingInput('ptbk-hostname-v1', hostname, engineId)`. */
export async function signHostnameClaim(
    signer: Signer,
    hostname: Hostname,
    engineId: EngineId,
    signal?: AbortSignal,
): Promise<Bytes> {
    return signer.sign(signingInput(SIGNING_CONTEXT.hostname, hostname, engineId), signal);
}

export function verifyHostnameClaim(
    publicKey: Bytes,
    hostname: Hostname,
    engineId: EngineId,
    signature: Bytes,
): boolean {
    return verifyEd25519(publicKey, signingInput(SIGNING_CONTEXT.hostname, hostname, engineId), signature);
}
