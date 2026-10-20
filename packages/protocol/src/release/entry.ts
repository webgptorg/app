import { z } from 'zod';

import type { Bytes } from '../bytes';
import { EngineVersion, Timestamp } from '../ids';
import { DsseEnvelope } from './dsse';
import { parseJsonPayload } from './json-payload';

export const MAX_RELEASE_ARTIFACTS = 32;
export const MAX_PROVENANCE_BYTES = 64 * 1024;
const MAX_ADVISORY_URL_LENGTH = 2048;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const GitCommit = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * A tag name that is safe inside the workflow SAN (`…@refs/tags/<gitTag>`): ASCII letters, digits, `.`, `_`, `-` and
 * `/`, starting and ending with a letter or digit, no `..` or `//`, at most 128 characters.
 */
export const GitTag = z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/)
    .refine((tag) => !tag.includes('..') && !tag.includes('//'), 'no ".." or "//" in a tag');

/** A file name, never a path: `[A-Za-z0-9._-]`, starting with a letter or digit, at most 128 characters. */
export const ArtifactName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export const Artifact = z.strictObject({
    name: ArtifactName,
    sha256: Sha256Hex,
    kind: z.enum(['engine', 'ui']),
});
export type Artifact = z.infer<typeof Artifact>;

export const ReleaseKind = z.enum(['regular', 'security']);
export type ReleaseKind = z.infer<typeof ReleaseKind>;

/** The DSSE payload of a release (`RELEASE_PAYLOAD_TYPE`), spec Interfaces 5. */
export const ReleaseEntry = z
    .strictObject({
        v: z.literal(1),
        version: EngineVersion,
        gitTag: GitTag,
        commit: GitCommit,
        artifacts: z.array(Artifact).min(1).max(MAX_RELEASE_ARTIFACTS),
        kind: ReleaseKind,
        advisory: z
            .url({ protocol: /^https$/ })
            .max(MAX_ADVISORY_URL_LENGTH)
            .nullable(),
        publishedAt: Timestamp,
    })
    .refine(
        (entry) => new Set(entry.artifacts.map(({ name }) => name)).size === entry.artifacts.length,
        'artifact names must be unique',
    )
    .refine((entry) => entry.kind !== 'security' || entry.advisory !== null, 'a security release needs an advisory')
    .refine((entry) => entry.artifacts.filter(({ kind }) => kind === 'ui').length <= 1, 'at most one ui artifact');
export type ReleaseEntry = z.infer<typeof ReleaseEntry>;

const utf8 = new TextEncoder();

/**
 * The published release record: the DSSE envelope signed by the release (and maintainer) keys, plus the Sigstore
 * bundle JSON from `sigstore.attest()` over the same payload and payload type.
 */
export const SignedRelease = z.strictObject({
    v: z.literal(1),
    envelope: DsseEnvelope,
    provenance: z
        .string()
        .min(1)
        .max(MAX_PROVENANCE_BYTES)
        .refine((bundle) => utf8.encode(bundle).length <= MAX_PROVENANCE_BYTES, 'provenance over 64 KiB'),
});
export type SignedRelease = z.infer<typeof SignedRelease>;

/** Strict UTF-8, JSON and schema; `undefined` for anything else. Call only after the signatures verified. */
export function parseReleaseEntry(payload: Bytes): ReleaseEntry | undefined {
    return parseJsonPayload(payload, ReleaseEntry);
}
