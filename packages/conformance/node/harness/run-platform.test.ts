import { afterEach, describe, expect, it } from 'vitest';

import type { CheckResult } from '../../src/index';
import { writeJunitReport } from '../../src/index';
import { REGISTRATION_SUITE } from '../index';
import { SELF_TEST_HEARTBEAT_INTERVAL_S, fakeEngineCommand } from '../testing/engines';
import type { EngineCommand } from './engine-process';
import { liveEngineGroups } from './engine-process';
import { runPlatformConformance } from './run-platform';
import { startRegisteredEngine } from '../fakes/dashboard';
import type { PlatformSuite } from './platform';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The harness itself, through the registration suite: the tunnel and ui-loader suites have self-tests of their own. */
async function run(command: EngineCommand, filter?: string) {
    return runPlatformConformance({
        command,
        suites: [REGISTRATION_SUITE],
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        seed: 1,
        expectations: { heartbeatIntervalMs: SELF_TEST_HEARTBEAT_INTERVAL_S * 1000, startTimeoutMs: 10_000 },
        ...(filter === undefined ? {} : { filter: (check) => check.id.includes(filter) }),
    });
}

function failure(results: readonly CheckResult[], id: string): string {
    const outcome = results.find((result) => result.id === id)?.outcome;
    return outcome?.kind === 'fail' ? outcome.detail : `not failed: ${outcome?.kind ?? 'missing'}`;
}

afterEach(() => {
    expect(liveEngineGroups()).toEqual([]);
});

/** How C-09 and C-10 use the harness: a registered engine, its identity, a restart in the same data directory. */
const registeredEngineSuite: PlatformSuite = {
    id: 'example',
    checks: [
        {
            id: 'example.registered.restart',
            suite: 'example',
            title: 'A registered engine keeps its identity across a restart',
            timeoutMs: (expectations) => expectations.heartbeatIntervalMs * 5,
            async run(ctx) {
                const registered = await startRegisteredEngine(ctx, { relays: ['relay-1.example.localhost' as never] });
                const dataDir = registered.engine.dataDir;
                await registered.restart({ PTBK_LINK_CODE: null });
                expect(registered.engine.dataDir).toBe(dataDir);
                expect(registered.engine.env['PTBK_LINK_CODE']).toBeUndefined();
                const beat = await registered.nextAcceptedHeartbeat(Date.now());
                expect(beat.pathEngineId).toBe(registered.identity.engineId);
                expect(
                    ctx.engineTarget(registered.engine, { baseUrl: new URL('https://x.localhost'), fetch }),
                ).toBeNull();
                const other = await ctx.engine();
                expect(other.dataDir).not.toBe(dataDir);
                return { kind: 'pass' };
            },
        },
        {
            id: 'example.output.long',
            suite: 'example',
            title: 'A failed check reports the end of a long output, and engines that never ran',
            async run(ctx) {
                await ctx.engine();
                const talkative = await ctx.engine();
                await talkative.start();
                await talkative.waitForExit(5000);
                return { kind: 'fail', detail: 'on purpose' };
            },
        },
        {
            id: 'example.fixture.close-fails',
            suite: 'example',
            title: 'A fixture that fails to close does not stop the run',
            run(ctx) {
                ctx.use({ close: () => Promise.reject(new Error('stuck')) });
                return Promise.resolve({ kind: 'pass' });
            },
        },
        {
            id: 'example.registered.exits',
            suite: 'example',
            title: 'An engine that stops before registering is reported as such',
            async run(ctx) {
                await startRegisteredEngine(ctx);
                return { kind: 'pass' };
            },
        },
    ],
};

describe('the harness', () => {
    it('runs plug-in checks with registered engines', async () => {
        const report = await runPlatformConformance({
            command: fakeEngineCommand(),
            suites: [registeredEngineSuite],
            filter: (check) => check.id === 'example.registered.restart',
            timeoutMs: 5000,
            signal: new AbortController().signal,
            expectations: { heartbeatIntervalMs: SELF_TEST_HEARTBEAT_INTERVAL_S * 1000, startTimeoutMs: 10_000 },
        });
        expect(report.results.map((result) => result.outcome)).toEqual([{ kind: 'pass' }]);
    });

    it('reports only the end of a long engine output', async () => {
        const report = await runPlatformConformance({
            command: {
                command: "head -c 40000 /dev/zero | tr '\\0' x; echo; echo the-end; exit 2",
                cwd: process.cwd(),
            },
            suites: [registeredEngineSuite],
            filter: (check) => check.id === 'example.output.long',
            timeoutMs: 10_000,
            signal: new AbortController().signal,
        });
        const output = report.results[0]?.engineOutput ?? '';
        expect(output).toContain('--- engine 1: 0 starts, exits: none ---');
        expect(output).toContain('--- engine 2: 1 starts, exits: 2 ---\n…');
        expect(output).toContain('the-end');
        expect(output.length).toBeLessThan(20_000);
    });

    it('carries on when a fixture fails to close', async () => {
        const report = await runPlatformConformance({
            command: { command: 'true', cwd: process.cwd() },
            suites: [registeredEngineSuite],
            filter: (check) => check.id === 'example.fixture.close-fails',
            timeoutMs: 5000,
            signal: new AbortController().signal,
        });
        expect(report.results.map((result) => result.outcome)).toEqual([{ kind: 'pass' }]);
    });

    it('says when an engine exits before it registers', async () => {
        const report = await runPlatformConformance({
            command: { command: 'exit 0', cwd: process.cwd() },
            suites: [registeredEngineSuite],
            filter: (check) => check.id === 'example.registered.exits',
            timeoutMs: 5000,
            signal: new AbortController().signal,
            expectations: { startTimeoutMs: 5000 },
            tempRoot: tmpdir(),
        });
        expect(failure(report.results, 'example.registered.exits')).toContain(
            'exited (status 0) before it could register',
        );
    });

    it('says when an engine never registers', async () => {
        const report = await runPlatformConformance({
            command: { command: 'exec sleep 600', cwd: process.cwd() },
            suites: [registeredEngineSuite],
            filter: (check) => check.id === 'example.registered.exits',
            timeoutMs: 5000,
            stopGraceMs: 200,
            signal: new AbortController().signal,
            expectations: { startTimeoutMs: 300 },
        });
        expect(failure(report.results, 'example.registered.exits')).toContain('did not register within 300 ms');
    });

    it('reports the engine output of a failed check', async () => {
        const report = await run(
            { command: 'echo "engine says hello" >&2; exit 3', cwd: process.cwd() },
            'registration.request.signature-verifies',
        );
        const [result] = report.results;
        expect(result?.outcome).toEqual({
            kind: 'fail',
            detail: expect.stringContaining('exited (status 3) before it could send a registration request') as string,
        });
        expect(result?.engineOutput).toContain('engine says hello');
        expect(report.results.every((entry) => entry.outcome.kind === 'fail')).toBe(true);
        expect(writeJunitReport(report)).toContain('<system-out>--- engine 1: 1 starts, exits: 3 ---');
    });

    it('stops an engine that ignores SIGTERM when the check times out', async () => {
        const report = await runPlatformConformance({
            command: { command: "trap '' TERM; sleep 600 & wait", cwd: process.cwd() },
            suites: [REGISTRATION_SUITE],
            filter: (check) => check.id === 'registration.request.signature-verifies',
            timeoutMs: 500,
            stopGraceMs: 200,
            signal: new AbortController().signal,
            expectations: { startTimeoutMs: 60_000 },
        });
        expect(report.results[0]?.outcome).toEqual({ kind: 'fail', detail: 'timed out after 500 ms' });
    });
});

describe('the run directory', () => {
    it('is removed even where the engine made directories read-only', async () => {
        const root = await mkdtemp(join(tmpdir(), 'run-platform-test-'));
        try {
            const suite: PlatformSuite = {
                id: 'example',
                checks: [
                    {
                        id: 'example.read-only.data',
                        suite: 'example',
                        title: 'Leaves a read-only tree behind, as the mock does with unpacked UI bundles',
                        async run(ctx) {
                            const bundle = join(await ctx.tempDir('engine'), 'ui', 'bundle');
                            await mkdir(join(bundle, 'assets'), { recursive: true });
                            await writeFile(join(bundle, 'assets', 'app.js'), 'x');
                            await chmod(join(bundle, 'assets'), 0o500);
                            await chmod(bundle, 0o500);
                            return { kind: 'pass' };
                        },
                    },
                ],
            };
            const report = await runPlatformConformance({
                command: { command: 'exit 0', cwd: process.cwd() },
                suites: [suite],
                timeoutMs: 5000,
                signal: new AbortController().signal,
                tempRoot: root,
            });
            expect(report.results.map((result) => result.outcome)).toEqual([{ kind: 'pass' }]);
            expect(await readdir(root)).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
