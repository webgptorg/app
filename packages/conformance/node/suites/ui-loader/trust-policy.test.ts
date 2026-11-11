import { afterEach, describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../../src/index';
import type { EngineCommand } from '../../harness/engine-process';
import { liveEngineGroups } from '../../harness/engine-process';
import { runPlatformConformance } from '../../harness/run-platform';
import { fakeEngineCommand } from '../../testing/engines';
import { createUiLoaderPlatformSuite } from './index';
import { TRUST_POLICY_CHECKS, TRUST_POLICY_FILE_ENV } from './trust-policy';

const shell = (command: string): EngineCommand => ({ command, cwd: process.cwd() });

async function outcomes(options: {
    readonly command?: EngineCommand;
    readonly productionCommand?: EngineCommand;
}): Promise<Record<string, CheckOutcome>> {
    const ids = new Set(TRUST_POLICY_CHECKS.map((check) => check.id));
    const report = await runPlatformConformance({
        command: options.command ?? shell('exit 1'),
        ...(options.productionCommand === undefined ? {} : { productionCommand: options.productionCommand }),
        suites: [createUiLoaderPlatformSuite({ endpoints: null })],
        filter: (check) => ids.has(check.id),
        timeoutMs: 30_000,
        signal: AbortSignal.timeout(60_000),
        expectations: { heartbeatIntervalMs: 2000, startTimeoutMs: 3000, quietWindowMs: 500 },
        stopGraceMs: 1000,
    });
    return Object.fromEntries(report.results.map((result) => [result.id, result.outcome]));
}

function detailOf(outcome: CheckOutcome | undefined): string {
    return outcome?.kind === 'fail' ? outcome.detail : JSON.stringify(outcome);
}

const REFUSED = 'ui-loader.trust-policy.staging-refused-in-production';
const ACCEPTED = 'ui-loader.trust-policy.staging-accepted-outside-production';

afterEach(() => {
    expect(liveEngineGroups()).toEqual([]);
});

describe('the trust policy checks', () => {
    it('skip the production check when the run has no production build', async () => {
        expect((await outcomes({}))[REFUSED]).toEqual({ kind: 'skip', reason: 'no-production-build' });
    });

    it('pass a production build that exits non-zero at once, naming the file', async () => {
        const refusing = shell(`echo "\${${TRUST_POLICY_FILE_ENV}} is a staging trust policy" >&2; exit 3`);
        expect((await outcomes({ productionCommand: refusing }))[REFUSED]).toEqual({ kind: 'pass' });
    });

    it.each([
        ['keeps running', 'exec sleep 30', 'kept running for 3000 ms'],
        ['exits with status 0', 'exit 0', 'exited with status 0, not a failure status'],
        ['exits without naming the file', 'echo refused >&2; exit 1', 'does not name the policy file'],
    ])('fail a production build that %s', async (_name, command, expected) => {
        expect(detailOf((await outcomes({ productionCommand: shell(command) }))[REFUSED])).toContain(expected);
    });

    it('fail a production build that registers instead of refusing', async () => {
        const outcome = (await outcomes({ productionCommand: fakeEngineCommand() }))[REFUSED];
        expect(detailOf(outcome)).toContain('contacted the dashboard before refusing');
    });

    it('pass an engine that starts with the staging policy outside production', async () => {
        expect((await outcomes({ command: fakeEngineCommand() }))[ACCEPTED]).toEqual({ kind: 'pass' });
    });

    it('fail an engine that refuses the staging policy outside production', async () => {
        expect(detailOf((await outcomes({ command: shell('exit 1') }))[ACCEPTED])).toMatch(
            /^with a staging trust policy, the engine exited \(status 1\)/,
        );
    });
});
