import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, vi } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ci-scope.ts');
const ALL_JOBS = [
    'engine-ui-csp',
    'dashboard-csp',
    'mock-engine-browser',
    'e2e',
    'conformance',
    'infra',
    'relay-metrics',
    'relay-host-vm',
    'relay-deploy',
];
// A Tuesday and a Monday, in UTC.
const TUESDAY = '2026-11-03T03:17:00Z';
const MONDAY = '2026-11-09T03:17:00Z';

let template: string;
let repo: string;

// Every case runs git and the script several times; a busy runner needs more than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

// The user's git config (signing, hooks, templates) must not reach the fixture repository.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.test', ...args], {
        cwd: repo,
        env: gitEnv,
        encoding: 'utf8',
    }).trim();
}

function write(path: string, content: string): void {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
}

function commit(files: Record<string, string>): string {
    for (const [path, content] of Object.entries(files)) write(path, content);
    git('add', '-A');
    git('commit', '--quiet', '--message', 'change');
    return git('rev-parse', 'HEAD');
}

function run(args: readonly string[], event?: { name: string; payload: Record<string, unknown> }) {
    const outputFile = join(repo, '.output');
    writeFileSync(outputFile, '');
    const env: NodeJS.ProcessEnv = { ...gitEnv, GITHUB_OUTPUT: outputFile };
    delete env['GITHUB_EVENT_NAME'];
    delete env['GITHUB_EVENT_PATH'];
    delete env['GITHUB_SHA'];
    if (event !== undefined) {
        const eventFile = join(repo, '.event.json');
        writeFileSync(eventFile, JSON.stringify(event.payload));
        env['GITHUB_EVENT_NAME'] = event.name;
        env['GITHUB_EVENT_PATH'] = eventFile;
    }
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const outputs = Object.fromEntries(
        readFileSync(outputFile, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { outputs, log: result.stdout };
}

function changesOnPush(payload: Record<string, unknown>) {
    const { outputs, log } = run(['changes'], { name: 'push', payload });
    return {
        check: outputs['check'],
        workspaces: outputs['workspaces'],
        jobs: JSON.parse(outputs['jobs'] ?? 'null') as string[],
        log,
    };
}

beforeAll(() => {
    template = mkdtempSync(join(tmpdir(), 'ci-scope-'));
    repo = template;
    git('init', '--quiet', '--initial-branch', 'main');
    write('.gitignore', '.output\n.event.json\n');
    commit({
        'package.json': JSON.stringify({ name: 'root', scripts: { check: 'bun run lint && bun run test' } }),
        'apps/relay/package.json': JSON.stringify({
            name: '@ptbk/relay',
            dependencies: { '@ptbk/protocol': 'workspace:*' },
        }),
        'apps/relay/src/main.ts': 'export {};\n',
        'apps/dashboard/package.json': JSON.stringify({
            name: '@ptbk/dashboard',
            dependencies: { '@ptbk/protocol': 'workspace:*' },
        }),
        'apps/dashboard/src/main.ts': 'export {};\n',
        'packages/protocol/package.json': JSON.stringify({ name: '@ptbk/protocol' }),
        'packages/protocol/src/index.ts': 'export {};\n',
        'docs/guide.md': '# Guide\n',
    });
});

beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ci-scope-'));
    cpSync(template, repo, { recursive: true });
});

afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
});

afterAll(() => {
    rmSync(template, { recursive: true, force: true });
});

describe('changes on a push to main', () => {
    it('runs only what the push reaches since its before commit', () => {
        const before = git('rev-parse', 'HEAD');
        commit({ 'apps/relay/src/main.ts': 'export const relay = 1;\n' });
        const scope = changesOnPush({ before, forced: false });
        assert.equal(scope.check, 'affected');
        assert.equal(scope.workspaces, '@ptbk/relay');
        assert.deepEqual(scope.jobs, ['relay-metrics', 'relay-host-vm', 'relay-deploy']);
    });

    it('covers every commit of a push with several, and the dependents of a shared package', () => {
        const before = git('rev-parse', 'HEAD');
        commit({ 'docs/guide.md': '# Guide, revised\n' });
        commit({ 'packages/protocol/src/index.ts': 'export const version = 2;\n' });
        const scope = changesOnPush({ before, forced: false });
        assert.equal(scope.check, 'affected');
        assert.equal(scope.workspaces, '@ptbk/dashboard @ptbk/protocol @ptbk/relay');
        assert.deepEqual(scope.jobs, ['dashboard-csp', 'relay-metrics', 'relay-host-vm', 'relay-deploy']);
    });

    it('runs only the format checks for documentation', () => {
        const before = git('rev-parse', 'HEAD');
        commit({ 'docs/guide.md': '# Guide, revised\n', 'README.md': '# Readme\n' });
        const scope = changesOnPush({ before, forced: false });
        assert.equal(scope.check, 'format');
        assert.equal(scope.workspaces, '');
        assert.deepEqual(scope.jobs, []);
    });

    it('runs everything when a root file changes', () => {
        const before = git('rev-parse', 'HEAD');
        commit({ 'tsconfig.base.json': '{}\n' });
        const scope = changesOnPush({ before, forced: false });
        assert.equal(scope.check, 'full');
        assert.deepEqual(scope.jobs, ALL_JOBS);
    });

    it('runs everything when the push has no before commit', () => {
        commit({ 'docs/guide.md': '# Guide, revised\n' });
        for (const payload of [
            { before: '0000000000000000000000000000000000000000', forced: false },
            { before: '', forced: false },
            { forced: false },
            { before: '--output=/tmp/x', forced: false },
        ]) {
            const scope = changesOnPush(payload);
            assert.equal(scope.check, 'full', JSON.stringify(payload));
            assert.deepEqual(scope.jobs, ALL_JOBS);
            assert.match(scope.log, /no before commit/);
        }
    });

    it('runs everything for a force-push, or when it cannot tell', () => {
        const before = git('rev-parse', 'HEAD');
        commit({ 'docs/guide.md': '# Guide, revised\n' });
        for (const payload of [{ before, forced: true }, { before }]) {
            const scope = changesOnPush(payload);
            assert.equal(scope.check, 'full');
            assert.deepEqual(scope.jobs, ALL_JOBS);
            assert.match(scope.log, /force-push/);
        }
    });

    it('runs everything when the before commit is not an ancestor or not in the clone', () => {
        const replaced = commit({ 'apps/relay/src/main.ts': 'export const relay = 1;\n' });
        git('reset', '--quiet', '--hard', 'HEAD^1');
        commit({ 'docs/guide.md': '# Guide, revised\n' });
        for (const before of [replaced, 'a'.repeat(40)]) {
            const scope = changesOnPush({ before, forced: false });
            assert.equal(scope.check, 'full');
            assert.deepEqual(scope.jobs, ALL_JOBS);
            assert.match(scope.log, /is not an ancestor/);
        }
    });
});

describe('changes on other events', () => {
    it('scopes a pull request against the base its merge commit merges into', () => {
        git('checkout', '--quiet', '-b', 'feature');
        commit({ 'apps/dashboard/src/main.ts': 'export const dashboard = 1;\n' });
        git('checkout', '--quiet', 'main');
        commit({ 'apps/relay/src/main.ts': 'export const relay = 1;\n' });
        git('merge', '--quiet', '--no-ff', '--no-edit', 'feature');
        const { outputs } = run(['changes'], { name: 'pull_request', payload: {} });
        assert.equal(outputs['workspaces'], '@ptbk/dashboard');
        assert.deepEqual(JSON.parse(outputs['jobs'] ?? ''), ['dashboard-csp']);
    });

    it('runs everything for the nightly and a manual run', () => {
        for (const name of ['schedule', 'workflow_dispatch']) {
            const { outputs } = run(['changes'], { name, payload: {} });
            assert.equal(outputs['check'], 'full');
            assert.deepEqual(JSON.parse(outputs['jobs'] ?? ''), ALL_JOBS);
        }
    });
});

describe('nightly', () => {
    function decide(last: string, now: string): string | undefined {
        return run(['nightly', '--head', 'b'.repeat(40), '--last', last, '--now', now]).outputs['run'];
    }

    it('skips when main is still where the last passing nightly ran', () => {
        assert.equal(decide('b'.repeat(40), TUESDAY), 'false');
    });

    it('runs when main moved since the last passing nightly', () => {
        assert.equal(decide('c'.repeat(40), TUESDAY), 'true');
    });

    it('runs when no nightly has passed yet', () => {
        assert.equal(decide('', TUESDAY), 'true');
    });

    it('runs every Monday, even when main did not move', () => {
        assert.equal(decide('b'.repeat(40), MONDAY), 'true');
    });
});
