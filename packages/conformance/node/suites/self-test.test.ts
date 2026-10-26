import { describe, expect, it } from 'vitest';

import { runPlatformConformance } from '../harness/run-platform';
import { PLATFORM_SUITES } from '../index';
import { fakeEngineCommand, mockEngineCommand } from '../testing/engines';
import { EXPECTATIONS, UNTIL_C09, notPassing, run } from '../testing/self-test';

describe('the registration and heartbeat suites', () => {
    it('pass against the mock engine', async () => {
        expect(notPassing(await run(mockEngineCommand()))).toEqual(UNTIL_C09);
    });

    it('pass against the self-test engine, a second implementation', async () => {
        expect(notPassing(await run(fakeEngineCommand()))).toEqual(UNTIL_C09);
    });

    it('skip the cadence check when the interval is overridden', async () => {
        const report = await runPlatformConformance({
            command: fakeEngineCommand(),
            suites: PLATFORM_SUITES,
            filter: (check) => check.id === 'heartbeat.cadence.interval',
            timeoutMs: 30_000,
            signal: new AbortController().signal,
            expectations: { ...EXPECTATIONS, intervalOverridden: true },
        });
        expect(report.results[0]?.outcome).toMatchObject({ kind: 'skip' });
    });
});
