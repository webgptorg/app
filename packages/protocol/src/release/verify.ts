import type { Bytes } from '../bytes';
import { bytesEqual } from '../bytes';
import type { Clock } from '../clock';
import type { EngineVersion } from '../ids';
import { ed25519PublicKeyToBytes } from '../ids';
import { fromHexDigest } from './digest';
import {
    DsseEnvelope,
    REVOCATION_PAYLOAD_TYPE,
    RELEASE_PAYLOAD_TYPE,
    dsseKeyId,
    dssePayload,
    verifyDsseSignatures,
} from './dsse';
import type { Artifact, ReleaseEntry } from './entry';
import { SignedRelease, parseReleaseEntry } from './entry';
import type { UiBundleManifest } from './manifest';
import type { ProvenanceVerifier } from './provenance';
import { expectedWorkflowClaims } from './provenance';
import type { RevocationList } from './revocation';
import { REVOCATION_MAX_FUTURE_SKEW_MS, findRevocation, parseRevocationList } from './revocation';
import type { KeyRef } from './trust';
import { TrustPolicy, revocationSigners } from './trust';
import { compareEngineVersions } from './version';

export interface VerifyReleaseInput {
    /** The `SignedRelease` JSON value as fetched, unparsed. */
    readonly release: unknown;
    /** The revocation list's DSSE envelope JSON value as fetched, unparsed; `null` when none could be fetched. */
    readonly revocations: unknown;
    /** The `issuedAt` of the newest list accepted before (persisted by the caller), `null` before the first. */
    readonly lastAcceptedRevocationIssuedAt: Date | null;
    readonly policy: TrustPolicy;
    /** `manual`: the owner approved this release, which skips only the delay. */
    readonly mode: 'auto' | 'manual';
    readonly installedVersion: EngineVersion | null;
    /** When the engine first saw this envelope (persisted, keyed by payload SHA-256). */
    readonly firstSeenAt: Date;
    readonly signal?: AbortSignal;
}

export interface VerifyReleaseDeps {
    readonly provenance: ProvenanceVerifier;
    readonly clock: Clock;
}

export type MissingSignature = 'trusted-key' | 'release-key' | 'maintainers' | 'provenance';
export type RevocationsUnverifiableReason = 'missing' | 'invalid' | 'expired' | 'rolled-back';

/**
 * Every outcome after the revocation list was accepted carries its `issuedAt`, which the caller persists as the next
 * `lastAcceptedRevocationIssuedAt`.
 */
export type ReleaseVerification =
    | {
          readonly kind: 'ok';
          readonly entry: ReleaseEntry;
          readonly eligibleAt: Date;
          readonly revocationsIssuedAt: Date;
      }
    | { readonly kind: 'invalid-entry' }
    | { readonly kind: 'signature-threshold-not-met'; readonly missing: MissingSignature }
    | { readonly kind: 'not-in-log' }
    | { readonly kind: 'revocations-unverifiable'; readonly reason: RevocationsUnverifiableReason }
    | {
          readonly kind: 'revoked';
          readonly entry: ReleaseEntry;
          readonly reason: string;
          readonly revocationsIssuedAt: Date;
      }
    | { readonly kind: 'not-newer'; readonly entry: ReleaseEntry; readonly revocationsIssuedAt: Date }
    | {
          readonly kind: 'delay-not-elapsed';
          readonly entry: ReleaseEntry;
          readonly eligibleAt: Date;
          readonly revocationsIssuedAt: Date;
      };

type RevocationCheck =
    | { readonly kind: 'ok'; readonly list: RevocationList; readonly issuedAt: Date }
    | { readonly kind: 'unverifiable'; readonly reason: RevocationsUnverifiableReason };

function timeOf(date: Date, what: string): number {
    const time = date.getTime();
    // An invalid Date would compare false everywhere and silently pass the delay and expiry checks.
    if (!Number.isFinite(time)) throw new RangeError(`${what} is not a valid date`);
    return time;
}

async function keyIds(keys: readonly KeyRef[]): Promise<ReadonlySet<string>> {
    return new Set(await Promise.all(keys.map(({ publicKey }) => dsseKeyId(ed25519PublicKeyToBytes(publicKey)))));
}

function keyBytes(keys: readonly KeyRef[]): Bytes[] {
    return keys.map(({ publicKey }) => ed25519PublicKeyToBytes(publicKey));
}

function countIn(valid: ReadonlySet<string>, ids: ReadonlySet<string>): number {
    return [...valid].filter((id) => ids.has(id)).length;
}

async function checkRevocations(
    revocations: unknown,
    policy: TrustPolicy,
    now: number,
    lastAccepted: number | null,
): Promise<RevocationCheck> {
    if (revocations === null || revocations === undefined) return { kind: 'unverifiable', reason: 'missing' };
    const envelope = DsseEnvelope.safeParse(revocations);
    if (!envelope.success || envelope.data.payloadType !== REVOCATION_PAYLOAD_TYPE) {
        return { kind: 'unverifiable', reason: 'invalid' };
    }
    const signers = revocationSigners(policy);
    const valid = await verifyDsseSignatures(envelope.data, keyBytes(signers));
    if (valid.size < policy.revocationRule.threshold) return { kind: 'unverifiable', reason: 'invalid' };
    const list = parseRevocationList(dssePayload(envelope.data));
    if (list === undefined) return { kind: 'unverifiable', reason: 'invalid' };
    const issuedAt = Date.parse(list.issuedAt);
    if (issuedAt > now + REVOCATION_MAX_FUTURE_SKEW_MS) return { kind: 'unverifiable', reason: 'invalid' };
    if (!(now < Date.parse(list.expiresAt))) return { kind: 'unverifiable', reason: 'expired' };
    if (lastAccepted !== null && issuedAt < lastAccepted) return { kind: 'unverifiable', reason: 'rolled-back' };
    return { kind: 'ok', list, issuedAt: new Date(issuedAt) };
}

/**
 * Whether an engine may install or serve a release (spec, Interfaces 5; ADR 0014). Pure apart from `deps`; returns
 * the first failure in this order: `invalid-entry`, `signature-threshold-not-met`, `not-in-log`,
 * `revocations-unverifiable`, `revoked`, `not-newer`, `delay-not-elapsed`.
 *
 * The payload is parsed only after a trusted key's signature over the PAE verified, so an unsigned malformed payload is
 * `signature-threshold-not-met`, a signed one `invalid-entry`. Provenance is checked after parsing, because the
 * expected certificate needs the entry's tag and commit. Regular releases need provenance and a release key; security
 * releases also need 2 of the 3 maintainer keys. Only `mode: 'manual'` skips anything, and only the delay.
 */
export async function verifyRelease(input: VerifyReleaseInput, deps: VerifyReleaseDeps): Promise<ReleaseVerification> {
    const now = timeOf(deps.clock.now(), 'clock.now()');
    const firstSeenAt = timeOf(input.firstSeenAt, 'firstSeenAt');
    const lastAccepted =
        input.lastAcceptedRevocationIssuedAt === null
            ? null
            : timeOf(input.lastAcceptedRevocationIssuedAt, 'lastAcceptedRevocationIssuedAt');
    // Re-checked so a policy built by hand cannot let one key count as both release and maintainer key.
    const policy = TrustPolicy.parse(input.policy);

    const release = SignedRelease.safeParse(input.release);
    if (!release.success || release.data.envelope.payloadType !== RELEASE_PAYLOAD_TYPE) {
        return { kind: 'invalid-entry' };
    }
    const { envelope, provenance } = release.data;
    const releaseIds = await keyIds(policy.releaseKeys);
    const maintainerIds = await keyIds(policy.maintainerKeys);
    const valid = await verifyDsseSignatures(envelope, keyBytes([...policy.releaseKeys, ...policy.maintainerKeys]));
    if (valid.size === 0) return { kind: 'signature-threshold-not-met', missing: 'trusted-key' };

    const payload = dssePayload(envelope);
    const entry = parseReleaseEntry(payload);
    if (entry === undefined) return { kind: 'invalid-entry' };
    if (countIn(valid, releaseIds) === 0) return { kind: 'signature-threshold-not-met', missing: 'release-key' };
    if (entry.kind === 'security' && countIn(valid, maintainerIds) < policy.securityThreshold) {
        return { kind: 'signature-threshold-not-met', missing: 'maintainers' };
    }

    const attestation = await deps.provenance.verifyProvenance(
        provenance,
        { payloadType: envelope.payloadType, payload },
        expectedWorkflowClaims(policy.workflowIdentity, entry),
        input.signal ?? new AbortController().signal,
    );
    switch (attestation.kind) {
        case 'invalid':
            return { kind: 'signature-threshold-not-met', missing: 'provenance' };
        case 'not-in-log':
            return { kind: 'not-in-log' };
        case 'verified':
            break;
    }
    if (attestation.trustedTime === null) return { kind: 'not-in-log' };
    const trustedTime = timeOf(attestation.trustedTime, 'trustedTime');

    const revocations = await checkRevocations(input.revocations, policy, now, lastAccepted);
    if (revocations.kind === 'unverifiable') {
        return { kind: 'revocations-unverifiable', reason: revocations.reason };
    }
    const revocationsIssuedAt = revocations.issuedAt;
    const revoked = findRevocation(revocations.list, entry.version);
    if (revoked !== undefined) return { kind: 'revoked', entry, reason: revoked.reason, revocationsIssuedAt };
    if (input.installedVersion !== null && compareEngineVersions(entry.version, input.installedVersion) <= 0) {
        return { kind: 'not-newer', entry, revocationsIssuedAt };
    }

    const delay = entry.kind === 'security' ? policy.delays.securityMs : policy.delays.regularMs;
    // publishedAt is self-asserted, so it can only lengthen the delay; trusted and first-seen time bound it from below.
    const eligibleAt = new Date(Math.max(Date.parse(entry.publishedAt), trustedTime, firstSeenAt) + delay);
    timeOf(eligibleAt, 'eligibleAt');
    if (input.mode === 'auto' && now < eligibleAt.getTime()) {
        return { kind: 'delay-not-elapsed', entry, eligibleAt, revocationsIssuedAt };
    }
    return { kind: 'ok', entry, eligibleAt, revocationsIssuedAt };
}

export type HashCheck = { readonly kind: 'ok' } | { readonly kind: 'hash-mismatch'; readonly name: string };

async function sha256(bytes: Bytes): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/** Compares the SHA-256 of a downloaded artifact with the one the verified entry pins. */
export async function verifyArtifact(artifact: Artifact, bytes: Bytes): Promise<HashCheck> {
    return bytesEqual(await sha256(bytes), fromHexDigest(artifact.sha256))
        ? { kind: 'ok' }
        : { kind: 'hash-mismatch', name: artifact.name };
}

export type ManifestFilesCheck =
    | HashCheck
    | { readonly kind: 'missing-file'; readonly name: string }
    | { readonly kind: 'unexpected-file'; readonly name: string };

/**
 * Re-checks every unpacked file against the manifest: each listed file present with its size and SHA-256, and no file
 * the manifest does not list, so an unpacker bug cannot serve a file the release did not contain.
 */
export async function verifyManifestFiles(
    manifest: UiBundleManifest,
    files: ReadonlyMap<string, Bytes>,
): Promise<ManifestFilesCheck> {
    const listed = new Set(manifest.files.map(({ path }) => path));
    for (const path of files.keys()) {
        if (!listed.has(path)) return { kind: 'unexpected-file', name: path };
    }
    for (const file of manifest.files) {
        const bytes = files.get(file.path);
        if (bytes === undefined) return { kind: 'missing-file', name: file.path };
        if (bytes.length !== file.size || !bytesEqual(await sha256(bytes), fromHexDigest(file.sha256))) {
            return { kind: 'hash-mismatch', name: file.path };
        }
    }
    return { kind: 'ok' };
}
