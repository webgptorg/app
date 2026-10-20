// The `sign` job (X-03): signs the archive keylessly, writes the release payload bytes once and attests them with
// sigstore.attest(), which logs a DSSE entry in Rekor with an RFC 3161 timestamp. Needs the job's GitHub OIDC token.
//
//   bun run --filter @ptbk/engine-ui release:attest --tag <tag>
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PAYLOAD_TYPE } from '@ptbk/protocol';
import { attest, sign } from 'sigstore';

import { parseManifest } from './release/archive.ts';
import { sha256Hex } from './release/manifest.ts';
import { RELEASE_DIR, RELEASE_FILES, readPackageVersion } from './release/paths.ts';
import { buildReleasePayload } from './release/release-entry.ts';
import { parseReleaseTag } from './release/release-tag.ts';

/** Sigstore's public-good TSA, whose key is in the pinned trusted root. */
const TSA_URL = 'https://timestamp.sigstore.dev/api/v1/timestamp';

const { values } = parseArgs({ options: { tag: { type: 'string' } } });
const tag = parseReleaseTag(values.tag ?? '', await readPackageVersion());
if (tag.kind === 'invalid') throw new Error(tag.reason);

const archive = await readFile(join(RELEASE_DIR, RELEASE_FILES.archive));
const manifest = parseManifest(await readFile(join(RELEASE_DIR, RELEASE_FILES.manifest)));
if (manifest === undefined) throw new Error('release/manifest.json is not a valid manifest');
if (manifest.version !== tag.version) throw new Error(`manifest version ${manifest.version} is not ${tag.version}`);
// The certificate will pin this run's commit; a manifest from another commit could never verify.
if (manifest.commit !== process.env['GITHUB_SHA']) throw new Error('the manifest commit is not GITHUB_SHA');

const payload = buildReleasePayload({
    version: tag.version,
    gitTag: tag.tag,
    commit: manifest.commit,
    archiveSha256: sha256Hex(archive),
    publishedAt: new Date(),
});
// `wx`: the payload is written exactly once; every later step reads these bytes.
await writeFile(join(RELEASE_DIR, RELEASE_FILES.payload), payload, { flag: 'wx' });

const archiveBundle = await sign(archive, { tsaServerURL: TSA_URL });
await writeFile(join(RELEASE_DIR, RELEASE_FILES.archiveBundle), JSON.stringify(archiveBundle), { flag: 'wx' });
const provenance = await attest(Buffer.from(payload), RELEASE_PAYLOAD_TYPE, { tsaServerURL: TSA_URL });
await writeFile(join(RELEASE_DIR, RELEASE_FILES.provenance), JSON.stringify(provenance), { flag: 'wx' });
console.log(
    `attested ${tag.tag}: ${RELEASE_FILES.payload}, ${RELEASE_FILES.provenance}, ${RELEASE_FILES.archiveBundle}`,
);
