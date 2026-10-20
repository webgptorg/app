// Builds the release twice, in two fresh worktrees of HEAD at different paths, with different TZ, locale and umask,
// and compares the archives byte for byte; `--expect` also compares them with an archive built before (X-03).
//
//   bun run --filter @ptbk/engine-ui verify-reproducible [--tag ui-v<version>] [--expect release/engine-ui.tar.zst]
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { APP_DIR, RELEASE_FILES } from './release/paths.ts';
import { compareArchives } from './release/reproducible.ts';

const { values } = parseArgs({ options: { tag: { type: 'string' }, expect: { type: 'string' } } });
const repoRoot = resolve(APP_DIR, '..', '..');
const appPath = join('apps', 'engine-ui');

interface Variant {
    readonly dir: string;
    readonly env: Readonly<Record<string, string>>;
    readonly umask: string;
}

const scratch = await mkdtemp(join(tmpdir(), 'ptbk-ui-repro-'));
const variants: readonly Variant[] = [
    { dir: join(scratch, 'a'), env: { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }, umask: '022' },
    {
        dir: join(scratch, 'second', 'copy-with-a-longer-path'),
        env: { TZ: 'Asia/Kathmandu', LANG: 'cs_CZ.UTF-8', LC_ALL: 'cs_CZ.UTF-8' },
        umask: '077',
    },
];

function build({ dir, env, umask }: Variant): void {
    const run = (command: string, args: readonly string[], cwd: string): void => {
        // umask has no Node API for a child; a shell sets it and execs the command with the arguments untouched.
        execFileSync('/bin/sh', ['-c', 'umask "$0" && exec "$@"', umask, command, ...args], {
            cwd,
            stdio: 'inherit',
            env: { ...process.env, ...env },
        });
    };
    run('bun', ['install', '--frozen-lockfile'], dir);
    const tag = values.tag === undefined ? [] : ['--tag', values.tag];
    run(join(dir, appPath, 'node_modules', '.bin', 'tsx'), ['scripts/pack.ts', ...tag], join(dir, appPath));
}

let failure: string | undefined;
try {
    for (const variant of variants) {
        await mkdir(join(variant.dir, '..'), { recursive: true });
        execFileSync('git', ['worktree', 'add', '--detach', variant.dir, 'HEAD'], { cwd: repoRoot, stdio: 'inherit' });
        build(variant);
    }
    const [a, b] = await Promise.all(
        variants.map((variant) => readFile(join(variant.dir, appPath, 'release', RELEASE_FILES.archive))),
    );
    if (a === undefined || b === undefined) throw new Error('missing build output');
    const twice = compareArchives(a, b);
    if (twice.kind === 'different') failure = `two builds differ: ${twice.detail}`;
    else if (values.expect !== undefined) {
        const expected = compareArchives(await readFile(resolve(values.expect)), a);
        if (expected.kind === 'different') failure = `${values.expect} differs from a fresh build: ${expected.detail}`;
    }
    if (failure === undefined) console.log(`reproducible: sha256:${twice.kind === 'identical' ? twice.sha256 : ''}`);
} finally {
    for (const variant of variants) {
        execFileSync('git', ['worktree', 'remove', '--force', variant.dir], { cwd: repoRoot, stdio: 'ignore' });
    }
    await rm(scratch, { recursive: true, force: true });
}
if (failure !== undefined) {
    console.error(failure);
    process.exit(1);
}
