import type { Clock, ProvenanceVerifier, ReleaseEntry, TrustPolicy } from '@ptbk/protocol';
import {
    SignedRelease,
    bytesEqual,
    dssePayload,
    parseReleaseEntry,
    verifyArtifact,
    verifyManifestFiles,
    verifyRelease,
} from '@ptbk/protocol';

import { ARCHIVE_NAME, unpackBundle } from './archive.ts';

/** A downloaded release, as read from disk; JSON values unparsed. */
export interface ReleaseFiles {
    /** The `SignedRelease` (`release-log/ui-<version>.json`). */
    readonly release: unknown;
    readonly archive: Uint8Array<ArrayBuffer>;
    /** The manifest published next to the archive. */
    readonly manifestBytes: Uint8Array<ArrayBuffer>;
    /** A revocation list envelope, or `null` when none was supplied. */
    readonly revocations: unknown;
}

export interface VerifyReleaseFilesDeps {
    readonly policy: TrustPolicy;
    readonly provenance: ProvenanceVerifier;
    readonly clock: Clock;
}

export type ReleaseFilesCheck =
    | {
          readonly kind: 'ok';
          readonly entry: ReleaseEntry;
          /** `not-supplied`: no revocation list was given, so everything but revocation was checked. */
          readonly revocations: 'checked' | 'not-supplied';
      }
    | { readonly kind: 'refused'; readonly reason: string };

/**
 * C-06's `verifyRelease` on a published UI release, then the archive against the entry and every file against the
 * manifest. `mode: 'manual'` skips only the update delay, which is the installing engine's business; signatures,
 * provenance, log inclusion and trusted time are all required. Without a revocation list, `verifyRelease` stops at
 * `revocations-unverifiable: missing`, which it only reaches after every signature and provenance check passed; that
 * one outcome is accepted and reported as `not-supplied`.
 */
export async function verifyReleaseFiles(
    files: ReleaseFiles,
    deps: VerifyReleaseFilesDeps,
): Promise<ReleaseFilesCheck> {
    const now = deps.clock.now();
    const verdict = await verifyRelease(
        {
            release: files.release,
            revocations: files.revocations,
            lastAcceptedRevocationIssuedAt: null,
            policy: deps.policy,
            mode: 'manual',
            installedVersion: null,
            firstSeenAt: now,
        },
        { provenance: deps.provenance, clock: deps.clock },
    );
    let entry: ReleaseEntry;
    let revocations: 'checked' | 'not-supplied';
    switch (verdict.kind) {
        case 'ok':
            entry = verdict.entry;
            revocations = 'checked';
            break;
        case 'revocations-unverifiable': {
            if (verdict.reason !== 'missing' || files.revocations !== null) {
                return { kind: 'refused', reason: `revocations-unverifiable: ${verdict.reason}` };
            }
            const parsed = parseReleaseEntry(dssePayload(SignedRelease.parse(files.release).envelope));
            if (parsed === undefined) return { kind: 'refused', reason: 'invalid-entry' };
            entry = parsed;
            revocations = 'not-supplied';
            break;
        }
        case 'signature-threshold-not-met':
            return { kind: 'refused', reason: `signature-threshold-not-met: ${verdict.missing}` };
        case 'invalid-entry':
        case 'not-in-log':
        case 'revoked':
        case 'not-newer':
        case 'delay-not-elapsed':
            return { kind: 'refused', reason: verdict.kind };
    }

    const [artifact, ...others] = entry.artifacts;
    if (artifact === undefined || others.length > 0 || artifact.kind !== 'ui' || artifact.name !== ARCHIVE_NAME) {
        return { kind: 'refused', reason: `the entry must list exactly one ui artifact named ${ARCHIVE_NAME}` };
    }
    const archiveCheck = await verifyArtifact(artifact, files.archive);
    if (archiveCheck.kind !== 'ok') return { kind: 'refused', reason: `archive ${archiveCheck.kind}` };

    let bundle: ReturnType<typeof unpackBundle>;
    try {
        bundle = unpackBundle(files.archive);
    } catch (error) {
        return { kind: 'refused', reason: `archive does not unpack: ${error instanceof Error ? error.message : ''}` };
    }
    if (!bytesEqual(bundle.manifestBytes, files.manifestBytes)) {
        return { kind: 'refused', reason: 'manifest.json differs from the manifest inside the archive' };
    }
    if (bundle.manifest.version !== entry.version || bundle.manifest.commit !== entry.commit) {
        return { kind: 'refused', reason: 'the manifest names another version or commit than the entry' };
    }
    const filesCheck = await verifyManifestFiles(bundle.manifest, bundle.files);
    if (filesCheck.kind !== 'ok') return { kind: 'refused', reason: `${filesCheck.kind}: ${filesCheck.name}` };
    return { kind: 'ok', entry, revocations };
}
