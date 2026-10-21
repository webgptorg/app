// Development and e2e only: publishes UI bundles that X-03's `pack` wrote into a release store directory, signed with
// release keys generated for this run and test attestations instead of Sigstore. The private keys live only in this
// process; it writes the trust policy (public keys) and prints only versions and hashes.
//
//   bun run ui-test-release <store dir> <policy dir> <bundle dir> <tampered bundle dir>
//
// Each bundle dir holds engine-ui.tar.zst and manifest.json. The first becomes `ui/latest.json`; the second is
// published as the release after it, its entry signing the genuine archive while the store serves it with one byte
// flipped.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { UiBundleManifest } from '@ptbk/protocol';

import { RELEASE_STORE_PATHS } from './adapters/ui/http-release-source';
import { TEST_ARCHIVE_NAME, createTestReleaseKeys, signTestRelease, signTestRevocations } from './testing/ui-releases';

const UI_TRUST_POLICY_FILE = 'ui-trust-policy.json';
const REVOCATIONS_VALID_MS = 7 * 24 * 3_600_000;

interface Bundle {
    readonly version: string;
    readonly commit: string;
    readonly archive: Uint8Array;
    readonly sha256: string;
}

async function readBundle(dir: string): Promise<Bundle> {
    const archive = new Uint8Array(await readFile(join(dir, TEST_ARCHIVE_NAME)));
    const manifest = UiBundleManifest.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
    return {
        version: manifest.version,
        commit: manifest.commit,
        archive,
        sha256: createHash('sha256').update(archive).digest('hex'),
    };
}

async function put(store: string, path: string, content: string | Uint8Array): Promise<void> {
    const target = join(store, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: 0o644 });
}

const [store, policyDir, goodDir, tamperedDir, ...rest] = process.argv.slice(2);
if (store === undefined || policyDir === undefined || goodDir === undefined || tamperedDir === undefined) {
    process.stderr.write('usage: ui-test-release <store dir> <policy dir> <bundle dir> <tampered bundle dir>\n');
    process.exit(2);
}
if (rest.length > 0) {
    process.stderr.write('ui-test-release: too many arguments\n');
    process.exit(2);
}

const keys = await createTestReleaseKeys();
const now = Date.now();
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const report: { version: string; sha256: string; served: string }[] = [];

for (const [dir, tamper] of [
    [goodDir, false],
    [tamperedDir, true],
] as const) {
    const bundle = await readBundle(dir);
    const record = await signTestRelease(keys, {
        version: bundle.version,
        commit: bundle.commit,
        archiveSha256: bundle.sha256,
        publishedAt: new Date(now),
    });
    const served = bundle.archive.slice();
    if (tamper) served[served.length >> 1] = (served[served.length >> 1] ?? 0) ^ 0x01;
    await put(store, RELEASE_STORE_PATHS.release(bundle.version), json(record));
    await put(store, RELEASE_STORE_PATHS.artifact(bundle.version, TEST_ARCHIVE_NAME), served);
    report.push({
        version: bundle.version,
        sha256: bundle.sha256,
        served: createHash('sha256').update(served).digest('hex'),
    });
}
const latest = report[0]?.version;
await put(store, RELEASE_STORE_PATHS.latest, json({ version: latest }));
await put(
    store,
    RELEASE_STORE_PATHS.revocations,
    json(
        await signTestRevocations(keys, {
            issuedAt: new Date(now - 60_000),
            expiresAt: new Date(now - 60_000 + REVOCATIONS_VALID_MS),
        }),
    ),
);
await writeFile(join(policyDir, UI_TRUST_POLICY_FILE), json(keys.policy), { mode: 0o644 });
process.stdout.write(json({ latest, releases: report }));
