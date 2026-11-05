import { describe, expect, it } from 'vitest';

import type { ConformanceReport } from './index';
import { ALL_SUITES, ENGINE_API_SUITE, runConformance } from './index';
import type { Defect, FakeEngineOptions } from './testing/fake-engine';
import { DEFECTS, createFakeEngine } from './testing/fake-engine';

async function run(options: FakeEngineOptions = {}, only?: string): Promise<ConformanceReport> {
    const { target } = await createFakeEngine(options);
    return runConformance({
        target,
        suites: ALL_SUITES,
        ...(only === undefined ? {} : { filter: (check) => check.id === only }),
        timeoutMs: 30_000,
        signal: AbortSignal.timeout(120_000),
        seed: 7,
    });
}

function outcomes(report: ConformanceReport): Record<string, string> {
    return Object.fromEntries(
        report.results.map(({ id, outcome }) => [
            id,
            outcome.kind === 'fail'
                ? `fail: ${outcome.detail}`
                : outcome.kind === 'skip'
                  ? `skip: ${outcome.reason}`
                  : 'pass',
        ]),
    );
}

/** The check each defect must fail. */
const CAUGHT_BY: Readonly<Record<Defect, string>> = {
    'leaked-secret': 'engine-api.secrets.never-returned',
    'extra-field': 'engine-api.schemas.responses-strict',
    'missing-auth': 'engine-api.auth.unauthenticated-401',
    'missing-permission-check': 'engine-api.permissions.mutations-denied',
    'plain-text-403': 'engine-api.permissions.mutations-denied',
    'duplicate-page-item': 'engine-api.pagination.walk',
    'missing-audit-entry': 'engine-api.audit.mutations-recorded',
    'wrong-audit-member': 'engine-api.audit.mutations-recorded',
    'wrong-problem-content-type': 'engine-api.schemas.problems',
    'cancel-after-finish-accepted': 'engine-api.runs.cancel-idempotent',
    'retry-from-completed-accepted': 'engine-api.runs.retry-only-failed',
    'non-idempotent-pause': 'engine-api.triggers.pause-resume-idempotent',
    'infected-file-downloadable': 'engine-api.files.infected-refused',
    'secret-canary-in-integration': 'engine-api.integrations.secrets-never-returned',
    'invalid-activity-item': 'engine-api.activity.known-items',
    'missing-permission-check-new-route': 'engine-api.permissions.mutations-denied',
};

describe('the suite against an in-process engine', () => {
    it('passes a correct engine on every check that can run', async () => {
        const report = await run();
        const results = outcomes(report);
        const notPassed = Object.entries(results).filter(([, outcome]) => outcome !== 'pass');
        expect(Object.fromEntries(notPassed)).toEqual({
            // The fake advertises every capability, so no route can be checked for capability-not-supported.
            'engine-api.capabilities.unadvertised-404':
                'skip: the engine advertises every capability this contract defines',
            // Reserved capabilities are design only, so no engine advertises them.
            'engine-api.live-audio.session': 'skip: capability-not-advertised',
            'engine-api.browser-tab.session': 'skip: capability-not-advertised',
        });
        expect(report.engineVersion).not.toBeNull();
        expect(report.results.every(({ cleanupFailures }) => cleanupFailures === 0)).toBe(true);
    });

    it('checks unadvertised capabilities and skips what the target cannot show', async () => {
        const results = outcomes(await run({ capabilities: [], heartbeat: false, memberPrivate: false }));
        expect(results['engine-api.capabilities.unadvertised-404']).toBe('pass');
        expect(results['engine-api.security.heartbeat-body']).toBe('skip: the engine has sent no heartbeat yet');
        expect(results['engine-api.cross-member.private-resources']).toBe(
            'skip: the target reports no resources private to one member',
        );
        expect(Object.values(results).some((outcome) => outcome.startsWith('fail'))).toBe(false);
        const capabilityChecks = Object.entries(results).filter(([id]) =>
            /^engine-api\.(runs|files|triggers|integrations|test-chat)\./.test(id),
        );
        expect(capabilityChecks.length).toBeGreaterThan(10);
        for (const [id, outcome] of capabilityChecks) expect(outcome, id).toBe('skip: capability-not-advertised');
    });

    it('skips only the capabilities the target does not advertise', async () => {
        const results = outcomes(await run({ capabilities: [{ id: 'runs', version: 1 }] }));
        expect(results['engine-api.runs.cancel-idempotent']).toBe('pass');
        expect(results['engine-api.files.download-attachment']).toBe('skip: capability-not-advertised');
        expect(results['engine-api.triggers.paging']).toBe('skip: capability-not-advertised');
        expect(results['engine-api.integrations.paging']).toBe('skip: capability-not-advertised');
        expect(results['engine-api.test-chat.draft-reply']).toBe('skip: capability-not-advertised');
        expect(results['engine-api.live-audio.session']).toBe('skip: capability-not-advertised');
        expect(results['engine-api.live.reserved']).toBe('pass');
        expect(results['engine-api.capabilities.unadvertised-404']).toBe('pass');
        expect(Object.values(results).some((outcome) => outcome.startsWith('fail'))).toBe(false);
    });

    it('fails an engine that advertises a reserved live capability', async () => {
        const results = outcomes(
            await run({ capabilities: [{ id: 'live-audio', version: 1 }] }, 'engine-api.live.reserved'),
        );
        expect(results['engine-api.live.reserved']).toMatch(/^fail: GET \/engine advertises live-audio@1/);
    });

    it.each(DEFECTS)('fails the matching check for %s', async (defect) => {
        const results = outcomes(await run({ defect }, CAUGHT_BY[defect]));
        expect(results[CAUGHT_BY[defect]]).toMatch(/^fail: /);
    });

    it('never puts a secret value, cookie or token into a report', async () => {
        const { target } = await createFakeEngine({ defect: 'leaked-secret' });
        const sent: string[] = [];
        const report = await runConformance({
            target: {
                ...target,
                fetch: async (input, init) => {
                    const request = new Request(input, init);
                    const body = request.body === null ? '' : await request.clone().text();
                    sent.push(body, request.headers.get('cookie') ?? '');
                    return target.fetch(request);
                },
            },
            suites: [ENGINE_API_SUITE],
            filter: (check) =>
                check.id.startsWith('engine-api.secrets.') || check.id === 'engine-api.auth.unauthenticated-401',
            timeoutMs: 30_000,
            signal: AbortSignal.timeout(120_000),
            seed: 7,
        });
        const text = JSON.stringify(report);
        const secrets = sent
            .flatMap((body) => [...body.matchAll(/"value":"([^"]+)"|fake_session=([^;]+)/g)])
            .map((match) => match[1] ?? match[2] ?? '')
            .filter((value) => value.length >= 16 || value.startsWith('token-'));
        expect(secrets.length).toBeGreaterThan(0);
        for (const secret of secrets) expect(text).not.toContain(secret);
    });
});
