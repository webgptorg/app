import { describe, expect, it } from 'vitest';

import type { EngineApiEndpoint, EngineTargetFactory } from '../harness/platform';
import { runPlatformConformance } from '../harness/run-platform';
import { createMockEngineTargetFactory } from '../targets/mock-engine';
import { fakeEngineCommand, mockEngineCommand } from '../testing/engines';
import { MEMBER_ACCESS_SUITE, NOTIFICATIONS_SUITE, OWNER_HANDOFF_SUITE } from '../index';
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

describe('the notifications suite', () => {
    // The mock serves notifications@1 from M-16 on; until then the suite must skip, not fail.
    it('skips against a mock engine without notifications@1', async () => {
        const results = await run(mockEngineCommand(), undefined, {}, createMockEngineTargetFactory(), [
            NOTIFICATIONS_SUITE,
        ]);
        expect(notPassing(results)).toEqual({
            'notifications.attention.recipients': 'skip: capability-not-advertised',
            'notifications.attention.switched-off': 'skip: capability-not-advertised',
        });
    }, 300_000);
});

describe('the owner-handoff suite', () => {
    // An owner makes an engine ignore the commitment, so these mocks start without one.
    const ownerless = () => mockEngineCommand('MOCK_PASSKEYS=none');

    it('passes against the mock engine', async () => {
        const results = await run(ownerless(), undefined, {}, createMockEngineTargetFactory(), [OWNER_HANDOFF_SUITE]);
        expect(notPassing(results)).toEqual({});
    }, 300_000);

    it('skips against a mock engine with the handoff off, which never signals without a commitment either', async () => {
        const mock = createMockEngineTargetFactory();
        const off: EngineTargetFactory = {
            engineEnv: async () => ({ ...(await mock.engineEnv()), PTBK_OWNER_HANDOFF: 'off' }),
            target: (engine, endpoint) => mock.target(engine, endpoint),
            certificateAuthority: (engine) => mock.certificateAuthority?.(engine) ?? Promise.resolve(null),
        };
        const results = await run(ownerless(), undefined, {}, off, [OWNER_HANDOFF_SUITE]);
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
