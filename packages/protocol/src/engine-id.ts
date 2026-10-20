import { encodeBase32Lower } from './base32';
import type { Bytes } from './bytes';
import type { Hostname } from './ids';
import { ED25519_PUBLIC_KEY_BYTES, EngineId, Hostname as HostnameSchema } from './ids';

const ENGINE_ID_LENGTH = 26;

/**
 * SHA-256 over the raw 32-byte public key (not its base64url text), base32 lowercase, first 26 characters (130 bits).
 * Lowercase because hostnames are case-insensitive. Throws a RangeError for a key that is not 32 bytes (a bug).
 */
export async function deriveEngineId(publicKey: Bytes): Promise<EngineId> {
    if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
        throw new RangeError(`Ed25519 public key must be ${String(ED25519_PUBLIC_KEY_BYTES)} bytes`);
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
    return EngineId.parse(encodeBase32Lower(digest).slice(0, ENGINE_ID_LENGTH));
}

/** `<engineId>.<engineDomain>`. Throws if the result exceeds 253 characters, i.e. the engine domain is misconfigured. */
export function defaultHostname(engineId: EngineId, engineDomain: Hostname): Hostname {
    return HostnameSchema.parse(`${engineId}.${engineDomain}`);
}

export type DefaultHostnameMatch =
    | { readonly kind: 'default'; readonly engineId: EngineId }
    | { readonly kind: 'custom' }
    | { readonly kind: 'invalid' };

/**
 * `custom` when `hostname` is outside `engineDomain`. Anything inside it, including the engine domain itself and deeper
 * subdomains, is `invalid` unless it is exactly `<valid engine ID>.<engineDomain>`, so no name in our namespace can be
 * routed through a custom-hostname claim.
 */
export function engineIdFromDefaultHostname(hostname: Hostname, engineDomain: Hostname): DefaultHostnameMatch {
    if (hostname === engineDomain) return { kind: 'invalid' };
    const suffix = `.${engineDomain}`;
    if (!hostname.endsWith(suffix)) return { kind: 'custom' };
    const engineId = EngineId.safeParse(hostname.slice(0, -suffix.length));
    return engineId.success ? { kind: 'default', engineId: engineId.data } : { kind: 'invalid' };
}
