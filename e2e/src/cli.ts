// Host-side driver for the stack: `bun run --filter @ptbk/e2e e2e | e2e:up | e2e:down | e2e:logs`, and the local dev
// stack's `bun run dev:stack | dev:link | dev:trust | dev:untrust` (dev-stack.ts). Only node: imports, so it runs
// before (and without) an install.
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { devMain } from './dev-stack.ts';
import type { ComposeTarget } from './docker.ts';
import { composeArgs, docker, dockerOutput, must } from './docker.ts';
import type { Scenario } from './scenarios.ts';
import { ALL_SCENARIO_OVERLAYS, ON_DEMAND_PROFILE, SCENARIOS, scenarioNamed } from './scenarios.ts';

const E2E_DIR = dirname(import.meta.dirname);
const RESULTS_DIR = join(E2E_DIR, 'test-results');
const CONTAINER_RESULTS_DIR = '/repo/e2e/test-results';
const DOCKER_SOCKET = '/var/run/docker.sock';
const WAIT_TIMEOUT_S = 300;

export type { ComposeTarget };
export { composeArgs };

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

/**
 * Every command but `up` sees the `test` profile (playwright) and the on-demand services, so they are built, cleaned up
 * and logged, and so playwright's dependencies resolve.
 */
export function withProfiles(target: ComposeTarget, ...args: readonly string[]): readonly string[] {
    return composeArgs(target, '--profile', 'test', '--profile', ON_DEMAND_PROFILE, ...args);
}

export function playwrightContainerName(target: ComposeTarget): string {
    return `${target.project}-playwright-run`;
}

/** `docker compose run` arguments; extra arguments go to `playwright test` (e.g. `--grep sse`). */
export function runArgs(target: ComposeTarget, playwrightArgs: readonly string[]): readonly string[] {
    const command = playwrightArgs.length === 0 ? [] : ['node_modules/.bin/playwright', 'test', ...playwrightArgs];
    return withProfiles(
        target,
        'run',
        '--name',
        playwrightContainerName(target),
        '--env',
        `E2E_SCENARIO=${target.scenario}`,
        '--no-deps',
        'playwright',
        ...command,
    );
}

/** The scenario's overlays, then any extra ones from `E2E_OVERLAYS` (such as `debug`). */
export function scenarioTarget(
    base: Omit<ComposeTarget, 'overlays' | 'scenario' | 'onDemand'>,
    scenario: Scenario,
    extraOverlays: readonly string[],
): ComposeTarget {
    return {
        ...base,
        scenario: scenario.name,
        overlays: [...new Set([...scenario.overlays, ...extraOverlays])],
        onDemand: scenario.onDemand ?? [],
    };
}

/** Creates the on-demand services' containers without starting them, as templates for the compose fixture's `run`. */
export function createOnDemandArgs(target: ComposeTarget): readonly string[] | null {
    if (target.onDemand.length === 0) return null;
    return composeArgs(target, 'up', '--no-start', '--no-build', '--no-deps', ...target.onDemand);
}

/** `down` and `logs` see the services of every scenario, so they clean up whatever an earlier run started. */
export function everyServiceTarget(target: ComposeTarget): ComposeTarget {
    return { ...target, overlays: [...new Set([...ALL_SCENARIO_OVERLAYS, ...target.overlays])] };
}

export function parseGid(output: string): string {
    const gid = output.trim();
    if (!/^\d{1,10}$/.test(gid)) throw new Error('could not read the group of the Docker socket');
    return gid;
}

/**
 * The Docker socket's group as containers see it, for the playwright service's `group_add`. Read from inside a
 * container because on macOS (OrbStack, Docker Desktop) the host's socket file is not the one Docker mounts.
 */
async function dockerSocketGid(target: ComposeTarget): Promise<string> {
    return parseGid(
        await dockerOutput([
            'run',
            '--rm',
            '--network',
            'none',
            '--entrypoint',
            'stat',
            '--volume',
            `${DOCKER_SOCKET}:${DOCKER_SOCKET}:ro`,
            `${target.project}-playwright`,
            '--format',
            '%g',
            DOCKER_SOCKET,
        ]),
    );
}

/** Removes a leftover playwright run container; absent is fine. */
function removeRunContainer(target: ComposeTarget): Promise<number> {
    return docker(['rm', '--force', '--volumes', playwrightContainerName(target)], 'ignore', 'ignore');
}

async function up(target: ComposeTarget): Promise<void> {
    // Built together so the shared install and build run once; `up` itself never builds.
    await must(withProfiles(target, 'build'));
    await must(
        composeArgs(
            target,
            'up',
            '--detach',
            '--no-build',
            '--wait',
            '--wait-timeout',
            // Every service but playwright, whose `test` profile is not active here; `run` starts it on its own.
            String(WAIT_TIMEOUT_S),
        ),
    );
    const onDemand = createOnDemandArgs(target);
    if (onDemand !== null) await must(onDemand);
}

async function down(target: ComposeTarget): Promise<void> {
    await removeRunContainer(target);
    await must(withProfiles(everyServiceTarget(target), 'down', '--volumes', '--remove-orphans', '--timeout', '10'));
}

function resultsDir(target: ComposeTarget): string {
    return join(RESULTS_DIR, target.scenario);
}

async function saveLogs(target: ComposeTarget): Promise<void> {
    const dir = resultsDir(target);
    await mkdir(dir, { recursive: true });
    const file = createWriteStream(join(dir, 'compose.log'));
    await docker(withProfiles(target, 'logs', '--no-color', '--timestamps'), file);
    await new Promise((resolve) => file.end(resolve));
    process.stderr.write(`e2e: service logs in ${join(dir, 'compose.log')}\n`);
}

/** Runs the suite in the playwright container and copies its results out (no bind mount: no root-owned files). */
async function runTests(target: ComposeTarget, playwrightArgs: readonly string[]): Promise<number> {
    // Cheap when nothing changed, and picks up edited tests against a running stack.
    await must(withProfiles(target, 'build', 'playwright'));
    process.env['E2E_DOCKER_GID'] = await dockerSocketGid(target);
    await removeRunContainer(target);
    const code = await docker(runArgs(target, playwrightArgs));
    const dir = resultsDir(target);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await docker(['cp', `${playwrightContainerName(target)}:${CONTAINER_RESULTS_DIR}/.`, dir], 'ignore');
    await removeRunContainer(target);
    return code;
}

async function runScenario(target: ComposeTarget, playwrightArgs: readonly string[]): Promise<number> {
    const started = Date.now();
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
    const seconds = Math.round((Date.now() - started) / 1000);
    process.stderr.write(
        `e2e: scenario ${target.scenario} ${code === 0 ? 'passed' : 'failed'} in ${String(seconds)} s\n`,
    );
    return code;
}

/** Every scenario in turn (or only `E2E_SCENARIO`); one failing does not stop the others, so CI reports them all. */
async function e2e(
    base: Omit<ComposeTarget, 'overlays' | 'scenario' | 'onDemand'>,
    scenarios: readonly Scenario[],
    extraOverlays: readonly string[],
    playwrightArgs: readonly string[],
): Promise<number> {
    await rm(RESULTS_DIR, { recursive: true, force: true });
    const failed: string[] = [];
    for (const scenario of scenarios) {
        const code = await runScenario(scenarioTarget(base, scenario, extraOverlays), playwrightArgs);
        if (code !== 0) failed.push(scenario.name);
    }
    if (failed.length > 0) process.stderr.write(`e2e: failed scenarios: ${failed.join(', ')}\n`);
    return failed.length === 0 ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
    const [command, ...rest] = argv;
    const base = { project: projectName(dirname(E2E_DIR), process.env), e2eDir: E2E_DIR };
    const extraOverlays = parseOverlays(process.env['E2E_OVERLAYS']);
    const chosen = process.env['E2E_SCENARIO'];
    const target = scenarioTarget(base, scenarioNamed(chosen), extraOverlays);
    switch (command ?? '') {
        case 'e2e':
            return e2e(
                base,
                chosen === undefined || chosen === '' ? SCENARIOS : [scenarioNamed(chosen)],
                extraOverlays,
                rest,
            );
        case 'up':
            await up(target);
            return 0;
        case 'run':
            return runTests(target, rest);
        case 'down':
            await down(target);
            return 0;
        case 'logs':
            return docker(withProfiles(everyServiceTarget(target), 'logs', '--no-color', '--timestamps', ...rest));
        case 'dev':
        case 'link':
        case 'trust':
        case 'untrust':
            return devMain(command ?? '', rest, E2E_DIR);
        default:
            process.stderr.write('usage: cli.ts e2e|up|run|down|logs|dev|link|trust|untrust [args]\n');
            return 2;
    }
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2));
}
