import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { TrustedRoot } from '@sigstore/protobuf-specs';
import { toTrustMaterial } from '@sigstore/verify';

export const TRUSTED_ROOT_MEDIA_TYPE = 'application/vnd.dev.sigstore.trustedroot+json;version=0.1';
const TARGET_NAME = 'trusted_root.json';

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

/** `sigstore`'s TUF client caches verified targets under `<cache>/<mirror host>/targets/`; finds the one root there. */
export async function findCachedTrustedRoot(cacheDir: string): Promise<string> {
    const repos = (await readdir(cacheDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (repos.length !== 1 || repos[0] === undefined) {
        throw new Error(`expected one TUF repository in ${cacheDir}, found ${String(repos.length)}`);
    }
    return join(cacheDir, repos[0].name, 'targets', TARGET_NAME);
}
