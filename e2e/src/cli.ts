// Host-side driver for the stack: `bun run --filter @ptbk/e2e e2e | e2e:up | e2e:down | e2e:logs`. Only node:
// imports, so it runs before (and without) an install.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const E2E_DIR = dirname(import.meta.dirname);
const RESULTS_DIR = join(E2E_DIR, 'test-results');
const CONTAINER_RESULTS_DIR = '/repo/e2e/test-results';
const WAIT_TIMEOUT_S = 300;
/** Every service except `playwright`, which `run` starts on its own; naming the last one brings up the rest. */
const STACK_ENTRY_SERVICE = 'mock-engine';

export interface ComposeTarget {
    readonly project: string;
    readonly e2eDir: string;
    /** `compose.<name>.yaml` files layered over compose.yaml, in order. */
    readonly overlays: readonly string[];
}

/**
 * One project per checkout, so two worktrees never drive each other's containers. The fixed subnet still allows only
 * one running stack per Docker host; a second `up` fails on the overlapping network instead of hijacking the first.
 */
export function projectName(repoRoot: string, env: Readonly<Record<string, string | undefined>>): string {
    const configured = env['E2E_PROJECT'];
    if (configured !== undefined && configured !== '') return configured;
    const checkout = basename(repoRoot)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return checkout === '' ? 'ptbk-e2e' : `ptbk-e2e-${checkout}`;
}

export function parseOverlays(value: string | undefined): readonly string[] {
    const names = (value ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
    for (const name of names) {
        if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`E2E_OVERLAYS: "${name}" is not an overlay name`);
    }
    return names;
}

export function composeArgs(target: ComposeTarget, ...args: readonly string[]): readonly string[] {
    return [
        'compose',
        '--project-name',
        target.project,
        '--project-directory',
        target.e2eDir,
        '--file',
        join(target.e2eDir, 'compose.yaml'),
        ...target.overlays.flatMap((name) => ['--file', join(target.e2eDir, `compose.${name}.yaml`)]),
        ...args,
    ];
}

export function playwrightContainerName(target: ComposeTarget): string {
    return `${target.project}-playwright-run`;
}

/** `docker compose run` arguments; extra arguments go to `playwright test` (e.g. `--grep sse`). */
export function runArgs(target: ComposeTarget, playwrightArgs: readonly string[]): readonly string[] {
    const command = playwrightArgs.length === 0 ? [] : ['node_modules/.bin/playwright', 'test', ...playwrightArgs];
    return composeArgs(target, 'run', '--name', playwrightContainerName(target), '--no-deps', 'playwright', ...command);
}

type Output = 'inherit' | 'ignore' | NodeJS.WritableStream;

function docker(
    args: readonly string[],
    stdout: Output = 'inherit',
    stderr: 'inherit' | 'ignore' = 'inherit',
): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', [...args], {
            stdio: ['ignore', typeof stdout === 'string' ? stdout : 'pipe', stderr],
        });
        if (typeof stdout !== 'string') child.stdout?.pipe(stdout, { end: false });
        child.once('error', reject);
        child.once('close', (code) => {
            resolve(code ?? 1);
        });
    });
}

/** Removes a leftover playwright run container; absent is fine. */
function removeRunContainer(target: ComposeTarget): Promise<number> {
    return docker(['rm', '--force', '--volumes', playwrightContainerName(target)], 'ignore', 'ignore');
}

async function must(args: readonly string[]): Promise<void> {
    const code = await docker(args);
    if (code !== 0) throw new Error(`docker ${args.slice(0, 6).join(' ')} … exited with ${String(code)}`);
}

async function up(target: ComposeTarget): Promise<void> {
    // Built together so the shared install and build run once; `up` itself never builds.
    await must(composeArgs(target, '--profile', 'test', 'build'));
    await must(
        composeArgs(
            target,
            'up',
            '--detach',
            '--no-build',
            '--wait',
            '--wait-timeout',
            String(WAIT_TIMEOUT_S),
            STACK_ENTRY_SERVICE,
        ),
    );
}

async function down(target: ComposeTarget): Promise<void> {
    await removeRunContainer(target);
    await must(composeArgs(target, '--profile', 'test', 'down', '--volumes', '--remove-orphans', '--timeout', '10'));
}

async function saveLogs(target: ComposeTarget): Promise<void> {
    await mkdir(RESULTS_DIR, { recursive: true });
    const file = createWriteStream(join(RESULTS_DIR, 'compose.log'));
    await docker(composeArgs(target, '--profile', 'test', 'logs', '--no-color', '--timestamps'), file);
    await new Promise((resolve) => file.end(resolve));
    process.stderr.write(`e2e: service logs in ${join(RESULTS_DIR, 'compose.log')}\n`);
}

/** Runs the suite in the playwright container and copies its results out (no bind mount: no root-owned files). */
async function runTests(target: ComposeTarget, playwrightArgs: readonly string[]): Promise<number> {
    // Cheap when nothing changed, and picks up edited tests against a running stack.
    await must(composeArgs(target, '--profile', 'test', 'build', 'playwright'));
    await removeRunContainer(target);
    const code = await docker(runArgs(target, playwrightArgs));
    await mkdir(RESULTS_DIR, { recursive: true });
    await docker(['cp', `${playwrightContainerName(target)}:${CONTAINER_RESULTS_DIR}/.`, RESULTS_DIR], 'ignore');
    await removeRunContainer(target);
    return code;
}

async function e2e(target: ComposeTarget, playwrightArgs: readonly string[]): Promise<number> {
    await rm(RESULTS_DIR, { recursive: true, force: true });
    let code = 1;
    try {
        await up(target);
        code = await runTests(target, playwrightArgs);
    } catch (error) {
        process.stderr.write(`e2e: ${error instanceof Error ? error.message : 'failed'}\n`);
    } finally {
        if (code !== 0) await saveLogs(target);
        await down(target);
    }
    return code;
}

async function main(argv: readonly string[]): Promise<number> {
    const [command, ...rest] = argv;
    const target: ComposeTarget = {
        project: projectName(dirname(E2E_DIR), process.env),
        e2eDir: E2E_DIR,
        overlays: parseOverlays(process.env['E2E_OVERLAYS']),
    };
    switch (command ?? '') {
        case 'e2e':
            return e2e(target, rest);
        case 'up':
            await up(target);
            return 0;
        case 'run':
            return runTests(target, rest);
        case 'down':
            await down(target);
            return 0;
        case 'logs':
            return docker(composeArgs(target, '--profile', 'test', 'logs', '--no-color', '--timestamps', ...rest));
        default:
            process.stderr.write('usage: cli.ts e2e|up|run|down|logs [args]\n');
            return 2;
    }
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2));
}
