// Verifies a downloaded UI release with C-06's verifyRelease and the real Sigstore adapter against the pinned trusted
// root, then the archive and every file against the manifest (X-03). The directory holds engine-ui.tar.zst,
// manifest.json and release.json (the release log entry `release-log/ui-<version>.json`), and optionally
// revocations.json.
//
//   bun run --filter @ptbk/engine-ui release:verify <dir> [--policy <file>] [--trusted-root <file>]
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_FILES, STAGING_POLICY_FILE, TRUSTED_ROOT_FILE } from './release/paths.ts';
import { createSigstoreProvenanceVerifier } from './release/sigstore-provenance-verifier.ts';
import { readTrustPolicy } from './release/trust-policy.ts';
import { verifyReleaseFiles } from './release/verify-release-files.ts';

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { policy: { type: 'string' }, 'trusted-root': { type: 'string' } },
});
const [dir] = positionals;
if (dir === undefined || positionals.length !== 1) throw new Error('usage: release:verify <dir> [--policy <file>]');

const read = (name: string) => readFile(join(resolve(dir), name));
const json = async (name: string): Promise<unknown> => {
    try {
        return JSON.parse((await read(name)).toString('utf8'));
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        // Malformed JSON is the verifier's to refuse, not a crash.
        return undefined;
    }
};

const policyFile = values.policy === undefined ? STAGING_POLICY_FILE : resolve(values.policy);
const trustedRoot: unknown = JSON.parse(await readFile(resolve(values['trusted-root'] ?? TRUSTED_ROOT_FILE), 'utf8'));
const result = await verifyReleaseFiles(
    {
        release: await json(RELEASE_FILES.signedRelease),
        archive: await read(RELEASE_FILES.archive),
        manifestBytes: await read(RELEASE_FILES.manifest),
        revocations: await json(RELEASE_FILES.revocations),
    },
    {
        policy: await readTrustPolicy(policyFile),
        provenance: createSigstoreProvenanceVerifier(trustedRoot),
        clock: { now: () => new Date() },
    },
);
if (result.kind === 'refused') {
    console.error(`refused: ${result.reason}`);
    process.exit(1);
}
const revocations = result.revocations === 'checked' ? 'revocations checked' : 'no revocation list supplied';
console.log(`verified ${result.entry.gitTag} (${result.entry.version}, ${result.entry.commit}); ${revocations}`);
