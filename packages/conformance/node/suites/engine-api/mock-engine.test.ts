import { afterEach, describe, expect, it } from 'vitest';

import type { CheckResult } from '../../../src/index';
import { ENGINE_API_SUITE } from '../../../src/index';
import { liveEngineGroups } from '../../harness/engine-process';
import type { EngineTargetFactory } from '../../harness/platform';
import { runPlatformConformance } from '../../harness/run-platform';
import { createMockEngineTargetFactory } from '../../targets/mock-engine';
import { createSessionCommandTargetFactory } from '../../targets/session-command';
import { SELF_TEST_HEARTBEAT_INTERVAL_S, mockEngineCommand } from '../../testing/engines';
import { ENGINE_API_PLATFORM_SUITE, createEngineApiPlatformSuite } from './index';

const SUITE_TIMEOUT_MS = 300_000;

/**
 * What the mock cannot show: it advertises every known capability but no reserved one, and its member sessions come
 * without a passkey.
 */
const MOCK_SKIPS = {
    'engine-api.capabilities.unadvertised-404': 'skip: the engine advertises every capability this contract defines',
    'engine-api.live-audio.session': 'skip: capability-not-advertised',
    'engine-api.browser-tab.session': 'skip: capability-not-advertised',
    'engine-api.me.own-passkeys': 'skip: the member has no passkey to revoke (listing passed)',
};

function notPassed(results: readonly CheckResult[]): Record<string, string> {
    return Object.fromEntries(
        results.flatMap(({ id, outcome, engineOutput }) => {
            if (outcome.kind === 'pass') return [];
            if (outcome.kind === 'skip') return [[id, `skip: ${outcome.reason}`]];
            return [[id, `fail: ${outcome.detail}\n${engineOutput ?? ''}`]];
        }),
    );
}

async function runAgainstMock(targets: EngineTargetFactory, skips: Readonly<Record<string, string>>) {
    const report = await runPlatformConformance({
        // A seeded team, so the checks that need existing data (an infected file, an ended trigger) have it, with the
        // optional file scanning switched on so its checks run too.
        command: mockEngineCommand(
            'MOCK_SCENARIO=small-team MOCK_SEED=1 ' +
                'MOCK_CAPABILITIES=runs,tasks,files,triggers,integrations,test-chat,access-requests,file-scanning,' +
                'members,api-tokens,audit,book-editor,agent-management,onboarding,wallet',
        ),
        suites: [ENGINE_API_PLATFORM_SUITE],
        targets,
        timeoutMs: 60_000,
        signal: AbortSignal.timeout(SUITE_TIMEOUT_MS),
        seed: 1,
        expectations: { heartbeatIntervalMs: SELF_TEST_HEARTBEAT_INTERVAL_S * 1000, startTimeoutMs: 30_000 },
    });
    expect(notPassed(report.results)).toEqual(skips);
    expect(report.results.map((result) => result.id)).toEqual(ENGINE_API_SUITE.checks.map((check) => check.id));
    expect(report.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
}

afterEach(() => {
    expect(liveEngineGroups()).toEqual([]);
});

describe('the engine-api suite on one engine the harness starts', () => {
    it(
        'passes every check against the mock engine with its control listener',
        async () => {
            await runAgainstMock(createMockEngineTargetFactory(), MOCK_SKIPS);
        },
        SUITE_TIMEOUT_MS,
    );

    it(
        'passes every check with sessions from the conformance-session command',
        async () => {
            const mock = mockEngineCommand();
            const sessions = createSessionCommandTargetFactory(
                { command: `${mock.command} conformance-session`, cwd: mock.cwd },
                { caFile: '{dataDir}/dev-ca/ca-cert.pem' },
            );
            // The mock's command asks its dev-only control listener, which needs a port of its own per engine.
            const mockControl = createMockEngineTargetFactory();
            await runAgainstMock(
                { ...sessions, engineEnv: () => mockControl.engineEnv() },
                {
                    ...MOCK_SKIPS,
                    // Engine policy that only the mock's own target reports.
                    'engine-api.cross-member.private-resources':
                        'skip: the target reports no resources private to one member',
                    // Raising a Wallet request is a test-mode lever the session command does not offer.
                    'engine-api.wallet.requests':
                        'skip: the target cannot raise a Wallet request (ConformanceTarget.walletRequest)',
                },
            );
        },
        SUITE_TIMEOUT_MS,
    );

    it('gives a target without sessions when the run has no session source', async () => {
        const seen: unknown[] = [];
        const suite = createEngineApiPlatformSuite({
            suite: {
                id: 'engine-api',
                checks: [
                    {
                        id: 'engine-api.example.sessionless',
                        suite: 'engine-api',
                        title: 'Reaches the engine without a session',
                        async run({ target }) {
                            const response = await target.fetch(new URL('/api/v1/engine', target.baseUrl));
                            seen.push(response.status, await target.session({ kind: 'owner' }), target.gateway);
                            seen.push(typeof target.enginePublicKey);
                            return { kind: 'pass' };
                        },
                    },
                ],
            },
        });
        const report = await runPlatformConformance({
            command: mockEngineCommand(),
            suites: [suite],
            timeoutMs: 60_000,
            signal: new AbortController().signal,
            expectations: { heartbeatIntervalMs: SELF_TEST_HEARTBEAT_INTERVAL_S * 1000 },
        });
        expect(report.results.map((result) => result.outcome)).toEqual([{ kind: 'pass' }]);
        expect(report.engineVersion).toBeNull();
        expect(seen).toEqual([401, null, undefined, 'string']);
    });
});
