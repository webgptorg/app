import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/** `apps/engine-ui`. */
export const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
export const DIST_DIR = join(APP_DIR, 'dist');
/** Build and signing output; only the staging trust policy in it is committed. */
export const RELEASE_DIR = join(APP_DIR, 'release');
export const STAGING_POLICY_FILE = join(RELEASE_DIR, 'trust-policy.staging.json');

/** File names inside a release directory, the same in CI, in R2 (`ui/<version>/…`) and in a download. */
export const RELEASE_FILES = Object.freeze({
    archive: 'engine-ui.tar.zst',
    manifest: 'manifest.json',
    archiveBundle: 'engine-ui.tar.zst.sigstore.json',
    /** The `ReleaseEntry` payload bytes, written once by the `sign` job and never re-serialised. */
    payload: 'release-payload.json',
    /** `sigstore.attest()` over the payload: becomes `SignedRelease.provenance`. */
    provenance: 'release-provenance.sigstore.json',
    /** The `SignedRelease`; published as `release-log/ui-<version>.json`. */
    signedRelease: 'release.json',
    revocations: 'revocations.json',
} as const);

export async function readPackageVersion(): Promise<string> {
    const json: unknown = JSON.parse(await readFile(join(APP_DIR, 'package.json'), 'utf8'));
    return z.object({ version: z.string() }).parse(json).version;
}
