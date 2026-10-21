import type { Bytes, EngineId, Hostname, RelayId, TunnelChallenge, TunnelFeature } from '@ptbk/protocol';
import {
    MAX_REGISTRY_HOSTNAMES,
    NONCE_BYTES,
    TunnelChallenge as TunnelChallengeSchema,
    deriveEngineId,
    ed25519PublicKeyToBytes,
    encodeBase64Url,
    negotiateTunnel,
    parseEngineMessage,
    verifyTunnelAuth,
} from '@ptbk/protocol';

import type { DnsResolver } from '../dns-resolver';
import type { EngineRegistry } from '../engine-registry';
import { routableHostnames } from '../hostname-policy';
import type { Logger } from '../logger';
import type { Random } from '../random';

/** What this relay announces in every `challenge`. */
export interface RelayTunnelOffer {
    readonly versions: readonly number[];
    readonly features: readonly TunnelFeature[];
}

export interface IssuedChallenge {
    /** Sent once, verified against once: the relay keeps it per connection and never reuses it. */
    readonly challenge: TunnelChallenge;
    readonly nonce: Bytes;
}

/** A fresh `NONCE_BYTES` nonce from `random`. Throws (a ZodError) only if `offer` breaks C-02's bounds: a bug. */
export function createChallenge(random: Random, relayId: RelayId, offer: RelayTunnelOffer): IssuedChallenge {
    const nonce = random.bytes(NONCE_BYTES);
    const challenge = TunnelChallengeSchema.parse({
        v: 1,
        type: 'challenge',
        nonce: encodeBase64Url(nonce),
        relayId,
        protocolVersions: [...offer.versions],
        features: [...offer.features],
    });
    return { challenge, nonce };
}

/** Internal reasons, logged on the relay only; `toWireRejection` decides what the engine learns. */
export type HandshakeRejectReason =
    | 'unknown-engine'
    | 'suspended'
    | 'bad-signature'
    | 'id-key-mismatch'
    | 'registry-unavailable'
    | 'unsupported-version'
    | 'malformed'
    | 'rate-limited';

export type HandshakeOutcome =
    | {
          readonly kind: 'accepted';
          readonly engineId: EngineId;
          readonly hostnames: readonly Hostname[];
          readonly protocolVersion: number;
          readonly features: readonly TunnelFeature[];
      }
    | {
          readonly kind: 'rejected';
          readonly reason: HandshakeRejectReason;
          /** Present once `auth` parsed; claimed by the engine, not proven unless the outcome is accepted. */
          readonly engineId?: EngineId;
      };

export interface VerifyAuthInput {
    /** The engine's text message, unparsed. */
    readonly auth: string;
    /** The challenge this relay sent on this connection; the relay's lists come from here, never from `auth`. */
    readonly challenge: TunnelChallenge;
    readonly registry: EngineRegistry;
    /** Whether the registry may be asked about `engineId` now; `false` refuses as `rate-limited`. */
    readonly admitLookup: (engineId: EngineId) => boolean;
    readonly dns: DnsResolver;
    readonly engineDomain: Hostname;
    readonly logger: Logger;
    /** Aborts the registry and DNS lookups; the returned promise then rejects with its reason. */
    readonly signal: AbortSignal;
}

/**
 * Checks run in an order that tells an unauthenticated peer nothing: the signature is verified before the engine's
 * status or the version negotiation is looked at, so only the key holder can learn that its engine is suspended or
 * that no version is shared.
 */
export async function verifyAuth(input: VerifyAuthInput): Promise<HandshakeOutcome> {
    const { challenge, registry, admitLookup, dns, engineDomain, logger, signal } = input;
    const parsed = parseEngineMessage(input.auth);
    if (parsed.kind === 'invalid') return { kind: 'rejected', reason: 'malformed' };
    const auth = parsed.message;
    const { engineId } = auth;
    const rejected = (reason: HandshakeRejectReason): HandshakeOutcome => ({ kind: 'rejected', reason, engineId });

    if (!admitLookup(engineId)) return rejected('rate-limited');
    const lookup = await registry.lookup(engineId, signal);
    switch (lookup.kind) {
        case 'not-found':
            return rejected('unknown-engine');
        case 'unavailable':
            return rejected('registry-unavailable');
        case 'found':
            break;
    }
    const { entry } = lookup;
    const publicKey = ed25519PublicKeyToBytes(entry.enginePublicKey);
    if ((await deriveEngineId(publicKey)) !== engineId) return rejected('id-key-mismatch');
    if (!verifyTunnelAuth(publicKey, challenge, auth)) return rejected('bad-signature');
    if (entry.status === 'suspended') return rejected('suspended');

    const negotiation = negotiateTunnel(
        { versions: challenge.protocolVersions, features: challenge.features },
        { versions: auth.protocolVersions, features: auth.features },
    );
    if (negotiation.kind === 'unsupported-version') return rejected('unsupported-version');

    const hostnames = await routableHostnames({ engineId, entry, engineDomain, dns, logger, signal });
    return {
        kind: 'accepted',
        engineId,
        // `ready` carries at most this many; the default hostname is first, so it always survives.
        hostnames: hostnames.slice(0, MAX_REGISTRY_HOSTNAMES),
        protocolVersion: negotiation.protocolVersion,
        features: negotiation.features,
    };
}
