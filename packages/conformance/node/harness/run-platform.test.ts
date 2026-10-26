import { afterEach, describe, expect, it } from 'vitest';

import type { CheckResult } from '../../src/index';
import { writeJunitReport } from '../../src/index';
import { PLATFORM_SUITES } from '../index';
import { SELF_TEST_HEARTBEAT_INTERVAL_S, fakeEngineCommand, mockEngineCommand } from '../testing/engines';
import type { EngineCommand } from './engine-process';
import { liveEngineGroups } from './engine-process';
import { runPlatformConformance } from './run-platform';
import { startRegisteredEngine } from '../fakes/dashboard';
import type { PlatformSuite } from './platform';
import { tmpdir } from 'node:os';

/** The tunnel suite runs minutes per engine and has its own self-test (node/suites/tunnel, node/tunnel/checks). */
const SUITES = PLATFORM_SUITES.filter(({ id }) => id !== 'tunnel');

async function run(command: EngineCommand, filter?: string) {
    return runPlatformConformance({
        command,
        suites: SUITES,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        seed: 1,
        expectations: { heartbeatIntervalMs: SELF_TEST_HEARTBEAT_INTERVAL_S * 1000, startTimeoutMs: 10_000 },
        ...(filter === undefined ? {} : { filter: (check) => check.id.includes(filter) }),
    });
}

function outcomes(results: readonly CheckResult[]): Record<string, string> {
    return Object.fromEntries(results.map((result) => [result.id, result.outcome.kind]));
}

function failure(results: readonly CheckResult[], id: string): string {
    const outcome = results.find((result) => result.id === id)?.outcome;
    return outcome?.kind === 'fail' ? outcome.detail : `not failed: ${outcome?.kind ?? 'missing'}`;
}

afterEach(() => {
    expect(liveEngineGroups()).toEqual([]);
});

describe('the platform suites', () => {
    it('pass against the mock engine', async () => {
        const report = await run(mockEngineCommand());
        expect(outcomes(report.results)).toEqual({ 'registration.request.signature-verifies': 'pass' });
    });

    it('pass against the self-test engine', async () => {
        const report = await run(fakeEngineCommand());
        expect(outcomes(report.results)).toEqual({ 'registration.request.signature-verifies': 'pass' });
    });

    it.each([
        ['bad-registration-signature', 'registration.request.signature-verifies', 'sig does not verify'],
        ['wrong-mode', 'registration.request.signature-verifies', 'mode is direct'],
    ])('fail for the defect %s', async (defect, id, expected) => {
        const report = await run(fakeEngineCommand(defect), id);
        expect(failure(report.results, id)).toContain(expected);
    });
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
        const report = await run({ command: 'echo "engine says hello" >&2; exit 3', cwd: process.cwd() });
        const [result] = report.results;
        expect(result?.outcome).toEqual({
            kind: 'fail',
            detail: expect.stringContaining('exited (status 3) before it could send a registration request') as string,
        });
        expect(result?.engineOutput).toContain('engine says hello');
        expect(writeJunitReport(report)).toContain('<system-out>--- engine 1: 1 starts, exits: 3 ---');
    });

    it('stops an engine that ignores SIGTERM when the check times out', async () => {
        const report = await runPlatformConformance({
            command: { command: "trap '' TERM; sleep 600 & wait", cwd: process.cwd() },
            suites: SUITES,
            timeoutMs: 500,
            stopGraceMs: 200,
            signal: new AbortController().signal,
            expectations: { startTimeoutMs: 60_000 },
        });
        expect(report.results[0]?.outcome).toEqual({ kind: 'fail', detail: 'timed out after 500 ms' });
    });
});
