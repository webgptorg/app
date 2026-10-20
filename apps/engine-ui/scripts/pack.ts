// Builds dist/ with SOURCE_DATE_EPOCH set to the commit time and writes release/engine-ui.tar.zst and
// release/manifest.json (X-03).
//
//   bun run --filter @ptbk/engine-ui pack [--tag ui-v<version>] [--allow-dirty]
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ENGINE_API_VERSION, ENGINE_UI_CSP } from '@ptbk/engine-api';
import { packBundle } from './release/archive.ts';
import { assertCleanTree, headCommit, headCommitTime } from './release/git.ts';
import { sha256Hex } from './release/manifest.ts';
import { APP_DIR, DIST_DIR, RELEASE_DIR, RELEASE_FILES, readPackageVersion } from './release/paths.ts';
import { parseReleaseTag } from './release/release-tag.ts';
import { readTree } from './release/tar.ts';

const { values } = parseArgs({ options: { tag: { type: 'string' }, 'allow-dirty': { type: 'boolean' } } });
const packageVersion = await readPackageVersion();

let version = packageVersion;
if (values.tag !== undefined) {
    const tag = parseReleaseTag(values.tag, packageVersion);
    if (tag.kind === 'invalid') throw new Error(tag.reason);
    version = tag.version;
}
if (values['allow-dirty'] !== true) assertCleanTree(APP_DIR);
const commit = headCommit(APP_DIR);
const sourceDateEpoch = headCommitTime(APP_DIR);

// Vite bakes `VITE_*` variables into the bundle (e.g. `VITE_UI_GALLERY`, which `test:csp` sets), so a release
// build never inherits them from the shell.
function releaseBuildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('VITE_')));
}

execFileSync(join(APP_DIR, 'node_modules', '.bin', 'vite'), ['build', '--configLoader', 'runner'], {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: { ...releaseBuildEnv(process.env), SOURCE_DATE_EPOCH: String(sourceDateEpoch), PTBK_UI_VERSION: version },
});

const packed = packBundle({
    version,
    commit,
    engineApiVersion: ENGINE_API_VERSION,
    csp: ENGINE_UI_CSP,
    files: await readTree(DIST_DIR),
    mtime: sourceDateEpoch,
});
await mkdir(RELEASE_DIR, { recursive: true });
await writeFile(join(RELEASE_DIR, RELEASE_FILES.archive), packed.archive);
await writeFile(join(RELEASE_DIR, RELEASE_FILES.manifest), packed.manifestBytes);
console.log(
    `${RELEASE_FILES.archive} ${version} ${commit} sha256:${sha256Hex(packed.archive)} (${String(packed.manifest.files.length)} files)`,
);
