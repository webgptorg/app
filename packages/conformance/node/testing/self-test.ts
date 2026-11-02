import { expect } from 'vitest';

import type { CheckResult } from '../../src/index';
import type { EngineCommand } from '../harness/engine-process';
import { liveEngineGroups } from '../harness/engine-process';
import { runPlatformConformance } from '../harness/run-platform';
import type { EngineTargetFactory, PlatformSuite } from '../harness/platform';
import { HEARTBEAT_SUITE, REGISTRATION_SUITE } from '../index';
import { SELF_TEST_HEARTBEAT_INTERVAL_S } from './engines';

/**
 * For the self-test of the platform suites: short windows so a suite runs in seconds, and the cadence check runs as
 * if 2 s were the production interval.
 */
export const EXPECTATIONS = {
    heartbeatIntervalMs: SELF_TEST_HEARTBEAT_INTERVAL_S * 1000,
    intervalOverridden: false,
    startTimeoutMs: 10_000,
    quietWindowMs: 2000,
};

/** The suites this self-test covers; the tunnel suite has its own. */
export const DASHBOARD_SUITES: readonly PlatformSuite[] = [REGISTRATION_SUITE, HEARTBEAT_SUITE];

export async function run(
    command: EngineCommand,
    ids?: readonly string[],
    expectations: Partial<typeof EXPECTATIONS> = {},
    targets?: EngineTargetFactory,
    suites: readonly PlatformSuite[] = DASHBOARD_SUITES,
): Promise<readonly CheckResult[]> {
    const report = await runPlatformConformance({
        command,
        suites,
        ...(targets === undefined ? {} : { targets }),
        timeoutMs: 30_000,
        stopGraceMs: 2000,
        signal: new AbortController().signal,
        seed: 1,
        expectations: { ...EXPECTATIONS, ...expectations },
        ...(ids === undefined ? {} : { filter: (check) => ids.includes(check.id) }),
    });
    expect(liveEngineGroups()).toEqual([]);
    return report.results;
}

export function notPassing(results: readonly CheckResult[]): Record<string, string> {
    return Object.fromEntries(
        results.flatMap(({ id, outcome }) => {
            switch (outcome.kind) {
                case 'pass':
                    return [];
                case 'fail':
                    return [[id, `fail: ${outcome.detail}`]];
                case 'skip':
                    return [[id, `skip: ${outcome.reason}`]];
            }
        }),
    );
}

/** The self-test engine has no engine API, so the one check that reads the security panel skips. */
export const WITHOUT_ENGINE_API = {
    'heartbeat.stale-ts.skew-shown': expect.stringMatching(/^skip: engine-api-unreachable/) as unknown,
};
