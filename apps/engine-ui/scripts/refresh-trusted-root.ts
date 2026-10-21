// Refreshes the pinned trusted root (packages/release-tools/src/trusted_root.json) from Sigstore's TUF repository
// (X-03). `createVerifier` runs sigstore-js's TUF client, which verifies the whole metadata chain from its embedded
// root before it caches the target; the bytes are then copied unchanged. The result is a trust anchor: it lands only
// through a reviewed PR.
//
//   bun run --filter @ptbk/engine-ui release:refresh-trusted-root
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVerifier } from 'sigstore';

import { PINNED_TRUSTED_ROOT_FILE as target, checkTrustedRoot } from '@ptbk/release-tools';

import { findCachedTrustedRoot } from './release/trusted-root.ts';

const cacheDir = await mkdtemp(join(tmpdir(), 'ptbk-tuf-'));
try {
    await createVerifier({ tufCachePath: cacheDir });
    const bytes = await readFile(await findCachedTrustedRoot(cacheDir));
    const check = checkTrustedRoot(bytes);
    if (check.kind === 'invalid') throw new Error(`TUF returned an unusable trusted root: ${check.reason}`);
    const previous = await readFile(target).catch(() => undefined);
    if (previous !== undefined && Buffer.compare(previous, bytes) === 0) {
        console.log('The pinned trusted_root.json is already current.');
    } else {
        await writeFile(target, bytes);
        console.log(`Updated ${target}. Review the diff and land it in its own PR.`);
    }
} finally {
    await rm(cacheDir, { recursive: true, force: true });
}
