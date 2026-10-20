import { z } from 'zod';

import { utf8Encode } from '../bytes';
import { EngineId, EngineVersion, Ed25519Signature, Hostname, RelayId, base64UrlOfLength } from '../ids';
import { MAX_HANDSHAKE_MESSAGE_BYTES, MAX_PROTOCOL_VERSION, NONCE_BYTES } from './constants';

const MAX_PROTOCOL_VERSIONS = 8;
const MAX_FEATURES = 32;
const MAX_READY_HOSTNAMES = 32;

export const TunnelFeature = z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .brand<'TunnelFeature'>();
export type TunnelFeature = z.infer<typeof TunnelFeature>;

/** Canonical base64url of exactly `NONCE_BYTES` random bytes; signed as the raw bytes. */
export const TunnelNonce = base64UrlOfLength(NONCE_BYTES).brand<'TunnelNonce'>();
export type TunnelNonce = z.infer<typeof TunnelNonce>;

/**
 * Byte order. Features are ASCII by schema, where UTF-16 code-unit order (JavaScript's `<`) equals byte order;
 * `localeCompare` would not.
 */
export function compareFeatures(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function isUnique(items: readonly unknown[]): boolean {
    return new Set(items).size === items.length;
}

function isCanonical(features: readonly string[]): boolean {
    return features.every((feature, index) => index === 0 || compareFeatures(features[index - 1] ?? '', feature) < 0);
}

const ProtocolVersion = z.int().min(1).max(MAX_PROTOCOL_VERSION);
const ProtocolVersions = z.array(ProtocolVersion).min(1).max(MAX_PROTOCOL_VERSIONS).refine(isUnique, 'duplicate');
const Features = z.array(TunnelFeature).max(MAX_FEATURES).refine(isUnique, 'duplicate');

export const TunnelChallenge = z.strictObject({
    v: z.literal(1),
    type: z.literal('challenge'),
    nonce: TunnelNonce,
    relayId: RelayId,
    protocolVersions: ProtocolVersions,
    features: Features,
});
export type TunnelChallenge = z.infer<typeof TunnelChallenge>;

/** Every field except `sig` is covered by the signature (see `tunnelAuthInput`). */
export const TunnelAuth = z.strictObject({
    v: z.literal(1),
    type: z.literal('auth'),
    engineId: EngineId,
    version: EngineVersion,
    protocolVersions: ProtocolVersions,
    features: Features,
    sig: Ed25519Signature,
});
export type TunnelAuth = z.infer<typeof TunnelAuth>;

export const TunnelReady = z.strictObject({
    v: z.literal(1),
    type: z.literal('ready'),
    protocolVersion: ProtocolVersion,
    // One accepted form, so the engine's check against `negotiateTunnel` is an exact comparison.
    features: Features.refine(isCanonical, 'features must be sorted by byte'),
    // Hostname lowercases, so the uniqueness check runs on the lowercased names.
    hostnames: z.array(Hostname).min(1).max(MAX_READY_HOSTNAMES).refine(isUnique, 'duplicate'),
});
export type TunnelReady = z.infer<typeof TunnelReady>;

export const TunnelRejectReason = z.enum([
    'auth-failed',
    'suspended',
    'unsupported-version',
    'timeout',
    'rate-limited',
]);
export type TunnelRejectReason = z.infer<typeof TunnelRejectReason>;

export const TunnelReject = z.strictObject({
    v: z.literal(1),
    type: z.literal('reject'),
    reason: TunnelRejectReason,
});
export type TunnelReject = z.infer<typeof TunnelReject>;

/** What the relay sends. Handshake messages stay at `v: 1` in every protocol version, so any engine can read a reject. */
export const RelayMessage = z.discriminatedUnion('type', [TunnelChallenge, TunnelReady, TunnelReject]);
export type RelayMessage = z.infer<typeof RelayMessage>;

export const EngineMessage = z.discriminatedUnion('type', [TunnelAuth]);
export type EngineMessage = z.infer<typeof EngineMessage>;

export type HandshakeParse<T> = { readonly kind: 'ok'; readonly message: T } | { readonly kind: 'invalid' };

const INVALID = Object.freeze({ kind: 'invalid' } as const);

function parseMessage<T>(schema: z.ZodType<T>, text: string): HandshakeParse<T> {
    // Each UTF-16 code unit takes at least one UTF-8 byte, so this bounds the work before encoding anything.
    if (text.length > MAX_HANDSHAKE_MESSAGE_BYTES) return INVALID;
    if (utf8Encode(text).length > MAX_HANDSHAKE_MESSAGE_BYTES) return INVALID;
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return INVALID;
    }
    const result = schema.safeParse(json);
    return result.success ? { kind: 'ok', message: result.data } : INVALID;
}

/** Engine side: parses a text message from the relay. Never throws. */
export function parseRelayMessage(text: string): HandshakeParse<RelayMessage> {
    return parseMessage(RelayMessage, text);
}

/** Relay side: parses a text message from an engine. Never throws. */
export function parseEngineMessage(text: string): HandshakeParse<EngineMessage> {
    return parseMessage(EngineMessage, text);
}

export interface TunnelOffer {
    readonly versions: readonly number[];
    readonly features: readonly TunnelFeature[];
}

export type TunnelNegotiation =
    | { readonly kind: 'ok'; readonly protocolVersion: number; readonly features: readonly TunnelFeature[] }
    | { readonly kind: 'unsupported-version' };

/**
 * The highest version both sides offer and exactly the features both offer, sorted by byte. Features only one side
 * knows drop out. Used by the relay to build `ready` and by the engine to check it.
 */
export function negotiateTunnel(relay: TunnelOffer, engine: TunnelOffer): TunnelNegotiation {
    const engineVersions = new Set(engine.versions);
    const common = relay.versions.filter((version) => engineVersions.has(version));
    if (common.length === 0) return { kind: 'unsupported-version' };
    const engineFeatures = new Set(engine.features);
    const features = [...new Set(relay.features.filter((feature) => engineFeatures.has(feature)))];
    return { kind: 'ok', protocolVersion: Math.max(...common), features: features.sort(compareFeatures) };
}

export type TunnelReadyCheck = { readonly kind: 'ok' } | { readonly kind: 'negotiation-mismatch' };

/**
 * Engine side, after `ready`: the relay's choice must equal `negotiateTunnel` over the lists the engine signed
 * (the relay's from `challenge`, its own from `auth`). On a mismatch the engine closes with `PROTOCOL_ERROR`, so a
 * party in the path cannot downgrade the session.
 */
export function checkTunnelReady(challenge: TunnelChallenge, auth: TunnelAuth, ready: TunnelReady): TunnelReadyCheck {
    const expected = negotiateTunnel(
        { versions: challenge.protocolVersions, features: challenge.features },
        { versions: auth.protocolVersions, features: auth.features },
    );
    const matches =
        expected.kind === 'ok' &&
        expected.protocolVersion === ready.protocolVersion &&
        expected.features.length === ready.features.length &&
        expected.features.every((feature, index) => feature === ready.features[index]);
    return matches ? { kind: 'ok' } : { kind: 'negotiation-mismatch' };
}
