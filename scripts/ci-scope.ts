// Decides which CI jobs a pull request needs, from the files it changes (`changes`), and runs the matching part of
// `bun run check` (`check`). Main and the schedule always run everything: ci.yml enforces that from the event, so
// nothing here can narrow them. Every guess errs towards running more: a file this script cannot attribute to a
// workspace or a job makes the run full.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

type CheckMode = 'full' | 'affected' | 'format';

interface Workspace {
    readonly name: string;
    readonly dir: string;
    readonly dependsOn: readonly string[];
}

interface JobInputs {
    readonly workspaces?: readonly string[];
    readonly paths?: readonly string[];
}

interface Scope {
    readonly check: CheckMode;
    readonly workspaces: readonly string[];
    readonly jobs: readonly string[];
    readonly reasons: readonly string[];
}

// What each gated ci.yml job exercises. A job runs when one of its workspaces is affected (changed, or depends on
// one that changed) or a file under one of its paths changed.
const JOBS: Readonly<Record<string, JobInputs>> = {
    'engine-ui-csp': { workspaces: ['@ptbk/engine-ui'] },
    'dashboard-csp': { workspaces: ['@ptbk/dashboard'] },
    'mock-engine-browser': { workspaces: ['@ptbk/mock-engine'] },
    e2e: { workspaces: ['@ptbk/e2e'] },
    conformance: { workspaces: ['@ptbk/conformance'] },
    infra: { paths: ['infra/'] },
    'relay-metrics': { workspaces: ['@ptbk/relay'] },
    'relay-host-vm': { workspaces: ['@ptbk/relay'], paths: ['infra/relay/'] },
    'relay-deploy': { workspaces: ['@ptbk/relay', '@ptbk/mock-engine'], paths: ['infra/relay/'] },
};

// Dependencies package.json does not declare: conformance tests run the built mock engine, and the e2e images build
// these workspaces (e2e/docker/stack.Dockerfile, apps/dashboard/Dockerfile.dev).
const UNDECLARED_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
    '@ptbk/conformance': ['@ptbk/mock-engine'],
    '@ptbk/e2e': [
        '@ptbk/dashboard',
        '@ptbk/engine-ui',
        '@ptbk/gateway-pages',
        '@ptbk/mock-engine',
        '@ptbk/relay',
        '@ptbk/release-tools',
        '@ptbk/ui',
    ],
};

const FULL_RUN_FILES = new Set(['.github/workflows/ci.yml', 'scripts/ci-scope.ts']);
// Read by no build or test; only Prettier and zizmor, which run on every pull request, look at them.
const FORMAT_ONLY_PREFIXES = ['.github/', '.vscode/', '.husky/', '.claude/'];
// Root package.json fields no build, test or install reads.
const MANIFEST_METADATA = new Set(['description', 'repository', 'homepage', 'bugs', 'keywords', 'author', 'license']);
const FORMAT_PARTS = new Set(['bun run format:check', 'bun run plan --check', 'bun run engine-guide']);
const CHECK_PART = /^bun run [\w:-]+(?: --[\w-]+)*$/;
const LOCK_SECTIONS_ATTRIBUTED = new Set(['workspaces', 'packages', 'catalog']);

function git(...args: readonly string[]): string {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fileAt(rev: string, path: string): string | undefined {
    try {
        return execFileSync('git', ['show', `${rev}:${path}`], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
    if (text === undefined) return undefined;
    try {
        // bun.lock is JSON with trailing commas.
        const value: unknown = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
        return isRecord(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function dependencyNames(manifest: Record<string, unknown>): string[] {
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) =>
        Object.keys(record(manifest[field])),
    );
}

function readWorkspaces(rev: string): Workspace[] {
    const dirs = git('ls-tree', '-d', '--name-only', rev, 'apps/', 'packages/', 'e2e')
        .split('\n')
        .filter((dir) => dir !== '');
    return dirs.flatMap((dir) => {
        const manifest = parseJson(fileAt(rev, `${dir}/package.json`));
        const name = manifest?.['name'];
        if (manifest === undefined || typeof name !== 'string') return [];
        const declared = dependencyNames(manifest).filter((dep) => dep.startsWith('@ptbk/'));
        return [{ name, dir, dependsOn: [...declared, ...(UNDECLARED_DEPENDENCIES[name] ?? [])] }];
    });
}

function sameJson(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function entryDependencies(entry: unknown): string[] {
    const meta = Array.isArray(entry) ? (entry as readonly unknown[])[2] : undefined;
    return isRecord(meta) ? dependencyNames(meta) : [];
}

// Whether a lockfile entry whose key is in `changed` is installed for `roots`. Keys nest like node_modules
// (`acme-client/@peculiar/x509` is the copy acme-client gets), so a dependency resolves from the requesting key
// outwards to the hoisted one.
function reachesChanged(
    packages: Record<string, unknown>,
    from: string | undefined,
    roots: readonly string[],
    changed: ReadonlySet<string>,
): boolean {
    const parents = (key: string): string[] =>
        [...key.matchAll(/\//g)]
            .map((match) => key.slice(0, match.index))
            .filter((prefix) => prefix in packages)
            .reverse();
    const resolve = (key: string | undefined, dep: string): string | undefined => {
        for (const scope of key === undefined ? [] : [key, ...parents(key)]) {
            if (`${scope}/${dep}` in packages) return `${scope}/${dep}`;
        }
        return dep in packages ? dep : undefined;
    };
    const seen = new Set<string>();
    const queue = roots.map((dep): [string | undefined, string] => [from, dep]);
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
        const key = resolve(...next);
        if (key === undefined || seen.has(key)) continue;
        seen.add(key);
        if (changed.has(key)) return true;
        for (const dep of entryDependencies(packages[key])) queue.push([key, dep]);
    }
    return false;
}

// Which workspaces install a package the lockfile change added, removed or moved.
function lockfileScope(
    base: Record<string, unknown>,
    head: Record<string, unknown>,
): { kind: 'workspaces'; dirs: string[] } | { kind: 'full'; reason: string } {
    for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
        if (!LOCK_SECTIONS_ATTRIBUTED.has(key) && !sameJson(base[key], head[key])) {
            return { kind: 'full', reason: `bun.lock: ${key} changed` };
        }
    }

    const basePackages = record(base['packages']);
    const headPackages = record(head['packages']);
    const changed = new Set<string>();
    for (const key of new Set([...Object.keys(basePackages), ...Object.keys(headPackages)])) {
        if (sameJson(basePackages[key], headPackages[key])) continue;
        if (key.startsWith('@ptbk/')) return { kind: 'full', reason: `bun.lock: workspace ${key} moved` };
        changed.add(key);
    }
    const baseCatalog = record(base['catalog']);
    const headCatalog = record(head['catalog']);
    const changedCatalog = [...new Set([...Object.keys(baseCatalog), ...Object.keys(headCatalog)])].filter(
        (name) => !sameJson(baseCatalog[name], headCatalog[name]),
    );

    const dirs: string[] = [];
    const baseWorkspaces = record(base['workspaces']);
    const headWorkspaces = record(head['workspaces']);
    for (const dir of new Set([...Object.keys(baseWorkspaces), ...Object.keys(headWorkspaces)])) {
        const before = record(baseWorkspaces[dir]);
        const after = record(headWorkspaces[dir]);
        const installs = (workspace: Record<string, unknown>, packages: Record<string, unknown>): boolean => {
            const name = workspace['name'];
            const from = typeof name === 'string' && name in packages ? name : undefined;
            return reachesChanged(packages, from, dependencyNames(workspace), changed);
        };
        const touched =
            !sameJson(before, after) ||
            [...dependencyNames(before), ...dependencyNames(after)].some((dep) => changedCatalog.includes(dep)) ||
            installs(before, basePackages) ||
            installs(after, headPackages);
        if (!touched) continue;
        if (dir === '') return { kind: 'full', reason: 'bun.lock: a root dev tool changed' };
        dirs.push(dir);
    }
    return { kind: 'workspaces', dirs };
}

// The root manifest's change: `none` (metadata only), `catalog` (pinned versions only, attributed through bun.lock)
// or `other`.
function manifestChange(before: Record<string, unknown>, after: Record<string, unknown>): 'none' | 'catalog' | 'other' {
    const catalogOf = (manifest: Record<string, unknown>): unknown => record(manifest['workspaces'])['catalog'];
    const withoutCatalog = (manifest: Record<string, unknown>): unknown => ({
        ...record(manifest['workspaces']),
        catalog: undefined,
    });
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (MANIFEST_METADATA.has(key)) continue;
        const same =
            key === 'workspaces'
                ? sameJson(withoutCatalog(before), withoutCatalog(after))
                : sameJson(before[key], after[key]);
        if (!same) return 'other';
    }
    return sameJson(catalogOf(before), catalogOf(after)) ? 'none' : 'catalog';
}

function everything(workspaces: readonly Workspace[], reason: string): Scope {
    return {
        check: 'full',
        workspaces: workspaces.map((workspace) => workspace.name).sort(),
        jobs: Object.keys(JOBS),
        reasons: [reason],
    };
}

function scope(base: string, head: string): Scope {
    const workspaces = readWorkspaces(head);
    const files = git('diff', '--name-only', '--no-renames', base, head)
        .split('\n')
        .filter((file) => file !== '');
    const reasons: string[] = [];
    const direct = new Set<string>();
    const otherPaths: string[] = [];

    const byDir = (dir: string): Workspace | undefined => workspaces.find((workspace) => workspace.dir === dir);
    const ownerOf = (file: string): Workspace | undefined =>
        workspaces.find((workspace) => file.startsWith(`${workspace.dir}/`));

    for (const file of files) {
        if (file.endsWith('.md') || file.startsWith('docs/')) continue;
        if (FULL_RUN_FILES.has(file)) return everything(workspaces, `${file} changed`);
        const owner = ownerOf(file);
        if (owner !== undefined) {
            direct.add(owner.name);
            reasons.push(`${file}: ${owner.name}`);
            continue;
        }
        if (file.startsWith('infra/') || FORMAT_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix))) {
            otherPaths.push(file);
            continue;
        }
        if (file === 'package.json') {
            const before = parseJson(fileAt(base, file));
            const after = parseJson(fileAt(head, file));
            const change = before === undefined || after === undefined ? 'other' : manifestChange(before, after);
            if (change === 'other') return everything(workspaces, 'package.json changed outside the catalog');
            if (change === 'catalog' && !files.includes('bun.lock')) {
                return everything(workspaces, 'the catalog changed without bun.lock');
            }
            continue;
        }
        if (file === 'bun.lock') {
            const before = parseJson(fileAt(base, file));
            const after = parseJson(fileAt(head, file));
            if (before === undefined || after === undefined) return everything(workspaces, 'bun.lock unreadable');
            const lock = lockfileScope(before, after);
            if (lock.kind === 'full') return everything(workspaces, lock.reason);
            for (const dir of lock.dirs) {
                const workspace = byDir(dir);
                if (workspace === undefined) return everything(workspaces, `bun.lock: unknown workspace ${dir}`);
                direct.add(workspace.name);
                reasons.push(`bun.lock: ${workspace.name}`);
            }
            continue;
        }
        return everything(workspaces, `${file} is shared by every module`);
    }

    const affected = new Set(direct);
    for (let grew = true; grew;) {
        grew = false;
        for (const workspace of workspaces) {
            if (!affected.has(workspace.name) && workspace.dependsOn.some((dep) => affected.has(dep))) {
                affected.add(workspace.name);
                grew = true;
            }
        }
    }

    const jobs = Object.entries(JOBS)
        .filter(
            ([, inputs]) =>
                (inputs.workspaces ?? []).some((name) => affected.has(name)) ||
                (inputs.paths ?? []).some((prefix) => otherPaths.some((file) => file.startsWith(prefix))),
        )
        .map(([job]) => job);

    return {
        check: affected.size > 0 ? 'affected' : 'format',
        workspaces: [...affected].sort(),
        jobs,
        reasons: reasons.length > 0 ? reasons : ['no workspace changed'],
    };
}

function runChanges(base: string, head: string): void {
    const result = scope(base, head);
    console.log(result.reasons.join('\n'));
    console.log(`check: ${result.check}\nworkspaces: ${result.workspaces.join(' ')}\njobs: ${result.jobs.join(' ')}`);
    const outputFile = process.env['GITHUB_OUTPUT'];
    if (outputFile !== undefined) {
        appendFileSync(
            outputFile,
            `check=${result.check}\nworkspaces=${result.workspaces.join(' ')}\njobs=${JSON.stringify(result.jobs)}\n`,
        );
    }
}

function run(command: string): void {
    console.log(`$ ${command}`);
    const [program = '', ...args] = command.split(' ');
    const result = spawnSync(program, args, { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
}

// The parts of the root `check` script that a scope needs, so a check added there runs here too. A script this
// cannot split into plain `bun run` parts runs whole.
function runCheck(mode: string, workspaces: readonly string[]): void {
    const manifest = parseJson(readFileSync('package.json', 'utf8'));
    const check = record(manifest?.['scripts'])['check'];
    const parts = typeof check === 'string' ? check.split(' && ') : [];
    const splittable =
        parts.length > 0 &&
        parts.every((part) => CHECK_PART.test(part)) &&
        parts.filter((part) => part === 'bun run test').length === 1;
    if (mode === 'full' || !splittable) {
        run('bun run check');
        return;
    }
    if (mode !== 'affected' && mode !== 'format') throw new Error(`unknown check mode: ${mode}`);
    for (const part of parts) {
        if (mode === 'format' && !FORMAT_PARTS.has(part)) continue;
        if (part !== 'bun run test') run(part);
        else if (workspaces.length > 0) {
            run(`bun run ${workspaces.map((name) => `--filter ${name}`).join(' ')} --sequential test`);
        }
    }
}

const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { base: { type: 'string', default: 'HEAD^1' }, head: { type: 'string', default: 'HEAD' } },
});

const command = positionals[0];
if (command === 'changes') runChanges(values.base, values.head);
else if (command === 'check') {
    runCheck(
        process.env['CHECK_MODE'] ?? 'full',
        (process.env['WORKSPACES'] ?? '').split(' ').filter((name) => name.startsWith('@ptbk/')),
    );
} else throw new Error('usage: node scripts/ci-scope.ts changes [--base <rev>] [--head <rev>] | check');
