import { describe, expect, it } from 'vitest';

import type { CheckResult } from '../../../src/index';
import { runPlatformConformance } from '../../harness/run-platform';
import { createMockEngineTargetFactory } from '../../targets/mock-engine';
import { mockEngineCommand } from '../../testing/engines';
import { TUNNEL_SUITE } from '.';

const only = process.env['C09_FILTER'];

describe('the tunnel suite against the mock engine', () => {
    it('passes every check', { timeout: 900_000 }, async () => {
        const report = await runPlatformConformance({
            command: mockEngineCommand(),
            suites: [TUNNEL_SUITE],
            targets: createMockEngineTargetFactory(),
            timeoutMs: 120_000,
            signal: AbortSignal.timeout(890_000),
            ...(only === undefined ? {} : { filter: (check) => check.id.includes(only) }),
            onResult: (result: CheckResult) => {
                if (process.env['C09_VERBOSE'] !== undefined) {
                    process.stderr.write(`${result.outcome.kind} ${result.id} ${String(result.durationMs)}ms\n`);
                }
            },
        });
        const notPassed = report.results.filter(({ outcome }) => outcome.kind !== 'pass');
        expect(notPassed.map(({ id, outcome }) => ({ id, outcome }))).toEqual([]);
    });
});
