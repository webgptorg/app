import { z } from 'zod';

import { decodeBase64Url, encodeBase64Url } from './base64url';
import type { Bytes } from './bytes';
import { utf8Encode } from './bytes';
import { base64UrlOfLength } from './ids';
import type { Random } from './random';

/** As the engine's own setup secret: 128 bits, so its plain SHA-256 hides it (ADR 0023). */
export const OWNER_SETUP_SECRET_BYTES = 16;
export const OWNER_SETUP_COMMITMENT_BYTES = 32;
/** How long the engine accepts the handoff secret, counted from registration. */
export const OWNER_HANDOFF_LIFETIME_MS = 30 * 60_000;

/** The pairing tab's setup secret: base64url of 16 random bytes, 22 characters, like the engine's own. */
export const OwnerSetupSecret = base64UrlOfLength(OWNER_SETUP_SECRET_BYTES).brand<'OwnerSetupSecret'>();
export type OwnerSetupSecret = z.infer<typeof OwnerSetupSecret>;

/** `base64url(SHA-256(UTF-8 of the secret's text))`: what the dashboard stores and the engine checks against. */
export const OwnerSetupCommitment = base64UrlOfLength(OWNER_SETUP_COMMITMENT_BYTES).brand<'OwnerSetupCommitment'>();
export type OwnerSetupCommitment = z.infer<typeof OwnerSetupCommitment>;

/**
 * Sent in heartbeats while the handoff slot is live, the engine has no owner and its address serves browsers. Absent
 * otherwise, and always from engines that never received a commitment.
 */
export const OwnerHandoff = z.enum(['ready']);
export type OwnerHandoff = z.infer<typeof OwnerHandoff>;

export function newOwnerSetupSecret(random: Random): OwnerSetupSecret {
    return OwnerSetupSecret.parse(encodeBase64Url(random.bytes(OWNER_SETUP_SECRET_BYTES)));
}

/** Hashes the text, not the decoded bytes, because engines already store their setup secret as SHA-256 of its text. */
export async function ownerSetupCommitment(secret: OwnerSetupSecret): Promise<OwnerSetupCommitment> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encode(secret)));
    return OwnerSetupCommitment.parse(encodeBase64Url(digest));
}

/** The raw SHA-256 a commitment carries, for an engine that keeps setup digests in another encoding (hex). */
export function ownerSetupCommitmentDigest(commitment: OwnerSetupCommitment): Bytes {
    const decoded = decodeBase64Url(commitment);
    if (decoded.kind !== 'ok') throw new TypeError('commitment is not canonical base64url');
    return decoded.bytes;
}
