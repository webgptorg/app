import { describe, expect, it } from 'vitest';

import type { EngineApiEndpoint, EngineTargetFactory } from '../harness/platform';
import { runPlatformConformance } from '../harness/run-platform';
import { createMockEngineTargetFactory } from '../targets/mock-engine';
import { fakeEngineCommand, mockEngineCommand } from '../testing/engines';
import { MEMBER_ACCESS_SUITE, OWNER_HANDOFF_SUITE } from '../index';
import { DASHBOARD_SUITES, EXPECTATIONS, WITHOUT_ENGINE_API, notPassing, run } from '../testing/self-test';

/** The mock's sessions, behind an engine API whose security panel lies about the clock skew in the given way. */
function lyingSecurityPanel(rewrite: (skew: { seconds: number } | null) => unknown): EngineTargetFactory {
    const mock = createMockEngineTargetFactory();
    const lying = (endpoint: EngineApiEndpoint): EngineApiEndpoint => ({
        baseUrl: endpoint.baseUrl,
        fetch: async (input, init) => {
            const response = await endpoint.fetch(input, init);
            if (!new Request(input, init).url.endsWith('/api/v1/security')) return response;
            const overview = (await response.json()) as { clockSkew: { seconds: number } | null };
            return Response.json(
                { ...overview, clockSkew: rewrite(overview.clockSkew) },
                { headers: response.headers },
            );
        },
    });
    return {
        engineEnv: () => mock.engineEnv(),
        target: (engine, endpoint) => mock.target(engine, lying(endpoint)),
        certificateAuthority: (engine) => mock.certificateAuthority?.(engine) ?? Promise.resolve(null),
    };
}

describe('the member-access suite', () => {
    it('passes against the mock engine', async () => {
        const results = await run(mockEngineCommand(), undefined, {}, createMockEngineTargetFactory(), [
            MEMBER_ACCESS_SUITE,
        ]);
        expect(notPassing(results)).toEqual({});
    }, 300_000);
});

describe('the owner-handoff suite', () => {
    it('skips against an engine that never signals, which never signals without a commitment either', async () => {
        const results = await run(mockEngineCommand(), undefined, {}, createMockEngineTargetFactory(), [
            OWNER_HANDOFF_SUITE,
        ]);
        const skipped = expect.stringMatching(/^skip: no heartbeat carried ownerHandoff/) as unknown;
        expect(notPassing(results)).toEqual({
            'owner-handoff.signal.prompt': skipped,
            'owner-handoff.setup.secret-accepted': skipped,
            'owner-handoff.setup.owner-spends-slot': skipped,
            'owner-handoff.setup.audited': skipped,
        });
    }, 300_000);
});

describe('the registration and heartbeat suites', () => {
    it('pass against the mock engine', async () => {
        expect(notPassing(await run(mockEngineCommand(), undefined, {}, createMockEngineTargetFactory()))).toEqual({});
    }, 180_000);

    it('pass against the self-test engine, a second implementation', async () => {
        expect(notPassing(await run(fakeEngineCommand()))).toEqual(WITHOUT_ENGINE_API);
    }, 180_000);

    it('skip the cadence check when the interval is overridden', async () => {
        const report = await runPlatformConformance({
            command: fakeEngineCommand(),
            suites: DASHBOARD_SUITES,
            filter: (check) => check.id === 'heartbeat.cadence.interval',
            timeoutMs: 30_000,
            signal: new AbortController().signal,
            expectations: { ...EXPECTATIONS, intervalOverridden: true },
        });
        expect(report.results[0]?.outcome).toMatchObject({ kind: 'skip' });
    });

    it.each([
        ['shows no skew', () => null, 'shows no clockSkew'],
        [
            'shows the skew with the wrong sign',
            (skew: { seconds: number } | null) => skew && { ...skew, seconds: -skew.seconds },
            'clockSkew.seconds is ',
        ],
    ])('fail the clock skew check for an engine API that %s', async (_name, rewrite, expected) => {
        const [result] = await run(
            mockEngineCommand(),
            ['heartbeat.stale-ts.skew-shown'],
            {},
            lyingSecurityPanel(rewrite),
        );
        expect(result?.outcome.kind === 'fail' ? result.outcome.detail : result?.outcome).toContain(expected);
    });
});
