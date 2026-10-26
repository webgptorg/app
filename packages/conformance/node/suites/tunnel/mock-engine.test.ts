import { describe, expect, it } from 'vitest';

import type { CheckResult } from '../../../src/index';
import { Findings, skip } from '../../../src/index';
import { startRegisteredEngine } from '../../fakes/dashboard';
import type { PlatformSuite } from '../../harness/platform';
import { startTunnelRelay } from '../../tunnel/tunnel-relay';
import { runPlatformConformance } from '../../harness/run-platform';
import { createMockEngineTargetFactory } from '../../targets/mock-engine';
import { mockEngineCommand } from '../../testing/engines';
import { TUNNEL_SUITE } from '.';

const only = process.env['C09_FILTER'];

/** The port other suites use to reach the engine API through a relay (C-10, engine-api in harness runs). */
const ENDPOINT_SUITE: PlatformSuite = {
    id: 'endpoint',
    checks: [
        {
            id: 'endpoint.mock.engine-info',
            suite: 'endpoint',
            title: 'GET /engine through the relay, with a session, names the engine that registered',
            async run(ctx) {
                const relay = await startTunnelRelay(ctx);
                const registered = await startRegisteredEngine(ctx, { env: relay.env });
                const endpoint = await relay.endpointFor(registered);
                const target = ctx.engineTarget(registered.engine, endpoint);
                if (target === null) skip('engine-api-unreachable');
                const credential = await target.session({ kind: 'owner' });
                const findings = new Findings();
                if (credential === null || !('cookie' in credential)) findings.add('no owner cookie');
                const response = await target.fetch(new URL('/api/v1/engine', target.baseUrl), {
                    headers: credential !== null && 'cookie' in credential ? { cookie: credential.cookie } : {},
                });
                const body = (await response.json()) as { engineId?: string; hostname?: string };
                if (response.status !== 200) findings.add(`GET /engine answered ${String(response.status)}`);
                if (body.engineId !== registered.identity.engineId) findings.add('another engineId');
                if (body.hostname !== endpoint.baseUrl.hostname) findings.add('another hostname');
                if ((await ctx.engineCertificateAuthority(registered.engine)) === null) findings.add('no dev CA');
                return findings.outcome();
            },
        },
    ],
};

describe('the engine API through the relay', () => {
    it('reaches the mock engine on its own origin with a session', async () => {
        const report = await runPlatformConformance({
            command: mockEngineCommand(),
            suites: [ENDPOINT_SUITE],
            targets: createMockEngineTargetFactory(),
            timeoutMs: 60_000,
            signal: AbortSignal.timeout(90_000),
        });
        expect(report.results.map(({ outcome }) => outcome)).toEqual([{ kind: 'pass' }]);
    });
});

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
