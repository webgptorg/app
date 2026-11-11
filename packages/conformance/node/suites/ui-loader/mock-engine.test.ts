import { afterEach, describe, expect, it } from 'vitest';

import type { CheckResult } from '../../../src/index';
import { UI_LOADER_CHECKS } from '../../../src/index';
import { liveEngineGroups } from '../../harness/engine-process';
import { runPlatformConformance } from '../../harness/run-platform';
import { createMockEngineTargetFactory } from '../../targets/mock-engine';
import { SELF_TEST_HEARTBEAT_INTERVAL_S, mockEngineCommand } from '../../testing/engines';
import { UI_LOADER_CHECK_TIMEOUT_MS, UI_LOADER_PLATFORM_SUITE } from './index';
import { TRUST_POLICY_CHECKS } from './trust-policy';

const SUITE_TIMEOUT_MS = (UI_LOADER_CHECKS.length + TRUST_POLICY_CHECKS.length) * UI_LOADER_CHECK_TIMEOUT_MS;

function line(result: CheckResult): string {
    const { outcome } = result;
    const output = result.engineOutput === undefined ? '' : `\n${result.engineOutput}`;
    const detail =
        outcome.kind === 'fail'
            ? `\n${outcome.detail}${output}`
            : outcome.kind === 'skip'
              ? ` (${outcome.reason})`
              : '';
    return `${outcome.kind} ${result.id} ${String(result.durationMs)} ms${detail}`;
}

afterEach(() => {
    expect(liveEngineGroups()).toEqual([]);
});

describe('the ui-loader suite against the mock engine', () => {
    it(
        'passes every check through the fake relay',
        async () => {
            const started = Date.now();
            const report = await runPlatformConformance({
                command: mockEngineCommand(),
                productionCommand: mockEngineCommand('NODE_ENV=production'),
                suites: [UI_LOADER_PLATFORM_SUITE],
                targets: createMockEngineTargetFactory(),
                timeoutMs: 30_000,
                signal: AbortSignal.timeout(SUITE_TIMEOUT_MS),
                seed: 1,
                expectations: { heartbeatIntervalMs: SELF_TEST_HEARTBEAT_INTERVAL_S * 1000, startTimeoutMs: 30_000 },
                onResult: (result) => process.stdout.write(`${line(result)}\n`),
            });
            process.stdout.write(`ui-loader suite against the mock: ${String(Date.now() - started)} ms\n`);
            const notPassed = Object.fromEntries(
                report.results
                    .filter((result) => result.outcome.kind !== 'pass')
                    .map((result) => [result.id, result.outcome]),
            );
            expect(notPassed).toEqual({});
            expect(report.results.map((result) => result.id)).toEqual(
                [...UI_LOADER_CHECKS, ...TRUST_POLICY_CHECKS].map((check) => check.id),
            );
        },
        SUITE_TIMEOUT_MS,
    );
});
