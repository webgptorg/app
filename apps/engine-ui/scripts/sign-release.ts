// The `publish` job (X-03): signs the DSSE PAE of the payload bytes with the release key from UI_RELEASE_KEY (base64url
// of the 32-byte seed) and writes the SignedRelease. Only keys the trust policy lists as release keys are accepted.
//
//   UI_RELEASE_KEY=… bun run --filter @ptbk/engine-ui release:sign [--policy release/trust-policy.staging.json]
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_DIR, RELEASE_FILES, STAGING_POLICY_FILE } from './release/paths.ts';
import { signRelease } from './release/signed-release.ts';
import { readTrustPolicy } from './release/trust-policy.ts';

const { values } = parseArgs({ options: { policy: { type: 'string' } } });
const seed = process.env['UI_RELEASE_KEY'];
if (seed === undefined || seed === '') throw new Error('UI_RELEASE_KEY is not set');

const signed = await signRelease({
    payload: await readFile(join(RELEASE_DIR, RELEASE_FILES.payload)),
    provenance: await readFile(join(RELEASE_DIR, RELEASE_FILES.provenance), 'utf8'),
    seed,
    policy: await readTrustPolicy(values.policy === undefined ? STAGING_POLICY_FILE : resolve(values.policy)),
});
await writeFile(join(RELEASE_DIR, RELEASE_FILES.signedRelease), `${JSON.stringify(signed, null, 2)}\n`, { flag: 'wx' });
console.log(`signed ${RELEASE_FILES.signedRelease}`);
