import { fileURLToPath } from 'node:url';

import { TrustedRoot } from '@sigstore/protobuf-specs';
import { toTrustMaterial } from '@sigstore/verify';

import pinnedTrustedRoot from './trusted_root.json' with { type: 'json' };

export const TRUSTED_ROOT_MEDIA_TYPE = 'application/vnd.dev.sigstore.trustedroot+json;version=0.1';

/**
 * Sigstore's public-good trusted root (Fulcio, Rekor, CT log and TSA keys), copied byte for byte from its TUF
 * repository and refreshed only in a reviewed PR (`release:refresh-trusted-root`). Ships inside every build that
 * imports it, so verification never fetches TUF metadata.
 */
export const PINNED_TRUSTED_ROOT: unknown = pinnedTrustedRoot;

/** Where the pinned root lives in the repo, for the refresh script; a bundled build reads `PINNED_TRUSTED_ROOT`. */
export const PINNED_TRUSTED_ROOT_FILE = fileURLToPath(new URL('trusted_root.json', import.meta.url));

export type TrustedRootCheck =
    { readonly kind: 'ok'; readonly root: unknown } | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Whether bytes are a trusted root the release verifier can use: the expected media type and at least one Fulcio CA,
 * Rekor log, CT log and TSA (the TSA is what gives a release its trusted time). `TrustedRoot.fromJSON` alone accepts
 * almost anything, so the counts are checked on the parsed message.
 */
export function checkTrustedRoot(bytes: Uint8Array): TrustedRootCheck {
    let json: unknown;
    try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        return { kind: 'invalid', reason: 'not UTF-8 JSON' };
    }
    if (typeof json !== 'object' || json === null) return { kind: 'invalid', reason: 'not a JSON object' };
    const root = TrustedRoot.fromJSON(json);
    if (root.mediaType !== TRUSTED_ROOT_MEDIA_TYPE) return { kind: 'invalid', reason: 'unexpected media type' };
    const parts = {
        certificateAuthorities: root.certificateAuthorities.length,
        tlogs: root.tlogs.length,
        ctlogs: root.ctlogs.length,
        timestampAuthorities: root.timestampAuthorities.length,
    };
    const missing = Object.entries(parts).find(([, count]) => count === 0);
    if (missing !== undefined) return { kind: 'invalid', reason: `no ${missing[0]}` };
    try {
        toTrustMaterial(root);
    } catch {
        return { kind: 'invalid', reason: 'keys do not load' };
    }
    return { kind: 'ok', root: json };
}
