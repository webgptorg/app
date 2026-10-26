import { afterEach, describe, expect, it } from 'vitest';

import type { CheckResult } from '../../../src/index';
import { UI_LOADER_CHECKS } from '../../../src/index';
import { liveEngineGroups } from '../../harness/engine-process';
import { runPlatformConformance } from '../../harness/run-platform';
import { createMockEngineTargetFactory } from '../../targets/mock-engine';
import { SELF_TEST_HEARTBEAT_INTERVAL_S, mockEngineCommand } from '../../testing/engines';
import type { EngineEndpoints } from './endpoints';
import { UI_LOADER_CHECK_TIMEOUT_MS, createUiLoaderPlatformSuite } from './index';

/** How the self-test reaches the mock engine's API: C-09's fake relay plugs in here; until then the full run skips. */
function endpointsUnderTest(): EngineEndpoints | null {
    return null;
}

const ENDPOINTS = endpointsUnderTest();

const SUITE_TIMEOUT_MS = UI_LOADER_CHECKS.length * UI_LOADER_CHECK_TIMEOUT_MS;

function run(endpoints: EngineEndpoints | null) {
    return runPlatformConformance({
        command: mockEngineCommand(),
        suites: [createUiLoaderPlatformSuite({ endpoints })],
        targets: createMockEngineTargetFactory(),
        timeoutMs: 30_000,
        signal: AbortSignal.timeout(SUITE_TIMEOUT_MS),
        seed: 1,
        expectations: { heartbeatIntervalMs: SELF_TEST_HEARTBEAT_INTERVAL_S * 1000, startTimeoutMs: 30_000 },
        onResult: (result) => process.stdout.write(`${line(result)}\n`),
    });
}

function line(result: CheckResult): string {
    const { outcome } = result;
    const detail =
        outcome.kind === 'fail'
            ? `\n${outcome.detail}${result.engineOutput === undefined ? '' : `\n${result.engineOutput}`}`
            : outcome.kind === 'skip'
              ? ` (${outcome.reason})`
              : '';
    return `${outcome.kind} ${result.id} ${String(result.durationMs)} ms${detail}`;
}

afterEach(() => {
    expect(liveEngineGroups()).toEqual([]);
});

describe('the ui-loader suite against the mock engine', () => {
    it('skips every check while nothing routes the engine API', async () => {
        const report = await run(null);
        expect(report.results.map((result) => [result.id, result.outcome])).toEqual(
            UI_LOADER_CHECKS.map((check) => [check.id, { kind: 'skip', reason: 'engine-api-unreachable' }]),
        );
    });

    it.skipIf(ENDPOINTS === null)(
        'passes every check through a relay',
        async () => {
            const report = await run(ENDPOINTS);
            const notPassed = Object.fromEntries(
                report.results
                    .filter((result) => result.outcome.kind !== 'pass')
                    .map((result) => [result.id, result.outcome]),
            );
            expect(notPassed).toEqual({});
            expect(report.results).toHaveLength(UI_LOADER_CHECKS.length);
        },
        SUITE_TIMEOUT_MS,
    );
});
