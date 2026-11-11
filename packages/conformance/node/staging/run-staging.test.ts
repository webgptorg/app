import { ENGINE_UI_CSP } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import type { WorldOptions } from '../testing/staging-world';
import {
    ENGINE_HOST,
    ENGINE_ID,
    OWNER_COOKIE,
    buildRelease,
    createStagingWorld,
    securityOverview,
    stagingOptions,
} from '../testing/staging-world';
import { runStagingCheck } from './run-staging';
import type { StagingCheckId, StagingOptions, StagingResult } from './types';
import { STAGING_CHECK_IDS } from './types';

async function run(world: WorldOptions = {}, options: Partial<StagingOptions> = {}) {
    const fake = createStagingWorld(world);
    const report = await runStagingCheck(stagingOptions(options), fake.ports);
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check])) as Record<
        StagingCheckId,
        StagingResult
    >;
    return { report, byId, requests: fake.requests };
}

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(body, {
        status,
        headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': ENGINE_UI_CSP, ...headers },
    });
const at = (path: string, response: () => Response, signedIn?: boolean) => (request: Request) => {
    if (new URL(request.url).pathname !== path) return undefined;
    if (signedIn !== undefined && (request.headers.get('cookie') === OWNER_COOKIE) !== signedIn) return undefined;
    return response();
};

describe('runStagingCheck', () => {
    it('passes a well-behaved engine on staging, every check in order', async () => {
        const { report, requests } = await run();
        expect(report.ok).toBe(true);
        expect(report.engine).toBe(`https://${ENGINE_HOST}`);
        expect(report.checks.map(({ id }) => id)).toEqual(STAGING_CHECK_IDS);
        expect(report.checks.filter(({ status }) => status !== 'pass')).toEqual([]);
        expect(report.checks.find(({ id }) => id === 'staging.ui.served')?.detail).toBe(
            'UI 0.1.0: index.html and 2 assets match the manifest',
        );
        expect(requests.every((request) => request.method === 'GET')).toBe(true);
        const api = requests.find((request) => new URL(request.url).pathname === '/api/v1/security');
        expect(api?.headers.get('origin')).toBe(`https://${ENGINE_HOST}`);
        expect(api?.headers.get('sec-fetch-site')).toBe('same-origin');
    });

    it('skips the session checks without a cookie and checks the latest release', async () => {
        const { report, byId, requests } = await run({}, { ownerCookie: null });
        expect(report.ok).toBe(true);
        expect(byId['staging.engine.info'].status).toBe('skip');
        expect(byId['staging.engine.info'].fix).toContain('__Host-ptbk_session');
        expect(byId['staging.ui.served'].status).toBe('skip');
        expect(byId['staging.ui.release'].detail).toContain('without a session this is the latest release');
        expect(byId['staging.headers.csp'].detail).toContain('GET / not checked without a session');
        expect(requests.some((request) => request.headers.has('cookie'))).toBe(false);
    });

    it('skips everything on the engine when TLS fails, but still checks the store', async () => {
        const { report, byId } = await run({ tls: { kind: 'failed', code: 'ECONNRESET' } });
        expect(report.ok).toBe(false);
        expect(byId['staging.tls.public-certificate'].fix).toContain('no tunnel');
        for (const id of ['staging.gateway.sign-in', 'staging.engine.info', 'staging.ui.served'] as const) {
            expect(byId[id]).toMatchObject({ status: 'skip', fix: 'fix staging.tls.public-certificate first' });
        }
        expect(byId['staging.ui.release'].status).toBe('pass');
    });

    it('fails the served check with the trust-policy hint when no UI is installed', async () => {
        const { report, byId } = await run({
            served: null,
            security: securityOverview({
                version: '0.0.0',
                bundleSha256: '0'.repeat(64),
                lastUpdateCheck: {
                    at: '2026-11-11T11:00:00Z',
                    outcome: 'refused',
                    version: '0.1.0',
                    reason: 'delay-not-elapsed',
                    revocationReason: null,
                    eligibleAt: '2026-11-11T11:05:00Z',
                },
            }),
        });
        expect(report.ok).toBe(false);
        const served = byId['staging.ui.served'];
        expect(served.status).toBe('fail');
        expect(served.detail).toContain('GET / answered 503 text/html');
        expect(served.detail).toContain('refused 0.1.0: delay-not-elapsed, eligible at 2026-11-11T11:05:00Z');
        expect(served.fix).toContain('PTBK_UI_TRUST_POLICY_FILE=');
        expect(byId['staging.ui.release'].detail).toContain(
            'the engine reports UI 0.0.0, which the store does not publish',
        );
    });

    it('fails when the engine reports a version the store lacks, even if it serves a page', async () => {
        const { byId } = await run({
            security: securityOverview({ version: '0.0.9', bundleSha256: '0'.repeat(64) }),
        });
        expect(byId['staging.ui.served']).toMatchObject({ status: 'fail' });
        expect(byId['staging.ui.served'].detail).toContain('the engine has not checked the store yet');
    });

    it('notes an older release than the latest one', async () => {
        const old = buildRelease('0.1.0');
        const { byId } = await run({ releases: [old, buildRelease('0.2.0')], served: old });
        expect(byId['staging.ui.release'].detail).toContain('UI 0.1.0 (latest 0.2.0)');
        expect(byId['staging.ui.served'].status).toBe('pass');
        expect(byId['staging.ui.served'].detail).toContain('older than the latest 0.2.0');
    });

    it.each([['another archive hash', { bundleSha256: 'f'.repeat(64) }, 'the engine reports bundle']])(
        'fails the served check on %s',
        async (_name, ui, message) => {
            const release = buildRelease('0.1.0');
            const { byId } = await run({
                security: securityOverview({ version: '0.1.0', ...ui }),
                served: release,
                releases: [release],
            });
            expect(byId['staging.ui.served'].detail).toContain(message);
        },
    );

    it.each([
        ['a modified index.html', at('/', () => html('<p>tampered</p>'), true), 'index.html differs from the manifest'],
        [
            'a modified asset',
            at('/assets/index-AbCdEf12.css', () => new Response('x{}'), true),
            'assets/index-AbCdEf12.css differs',
        ],
        [
            'a missing asset',
            at('/assets/index-AbCdEf12.js', () => new Response(null, { status: 404 }), true),
            'GET /assets/index-AbCdEf12.js answered 404',
        ],
        [
            'an unreachable asset',
            at('/assets/index-AbCdEf12.js', () => Response.error(), true),
            'GET /assets/index-AbCdEf12.js:',
        ],
        [
            'a refused cookie on /',
            at('/', () => new Response(null, { status: 303, headers: { Location: '/auth/sign-in' } }), true),
            'with the owner cookie answered 303',
        ],
        ['an unreachable /', at('/', () => Response.error(), true), 'GET /:'],
        [
            'a broken security overview',
            at('/api/v1/security', () => Response.json({ nope: true })),
            'does not match the contract',
        ],
    ])('fails the served check on %s', async (_name, route, message) => {
        const { byId } = await run({ route });
        expect(byId['staging.ui.served'].status).toBe('fail');
        expect(byId['staging.ui.served'].detail).toContain(message);
    });

    it('fails the served check on an asset outside the manifest', async () => {
        const release = buildRelease('0.1.0', { indexHtml: '<script src="/assets/other-12345678.js"></script>' });
        const route = at('/assets/other-12345678.js', () => new Response('x'), true);
        const { byId } = await run({ releases: [release], served: release, route });
        expect(byId['staging.ui.served'].detail).toContain(
            'assets/other-12345678.js is served but not in the manifest',
        );
    });

    it('skips the served check when the store has no valid release', async () => {
        const { byId } = await run({ latest: { version: 'not-a-version' } });
        expect(byId['staging.ui.release'].status).toBe('fail');
        expect(byId['staging.ui.release'].detail).toContain('ui/latest.json does not match the contract at version');
        expect(byId['staging.ui.served']).toMatchObject({ status: 'skip', fix: 'fix staging.ui.release first' });
    });

    it.each([
        [
            'latest.json missing',
            { route: at('/ui/latest.json', () => new Response(null, { status: 404 })) },
            'GET ui/latest.json answered 404',
        ],
        [
            'a record of another version',
            { releases: [{ ...buildRelease('0.1.0'), record: buildRelease('0.0.1').record }] },
            'is the record of 0.0.1',
        ],
        [
            'a wrong payload type',
            { releases: [buildRelease('0.1.0', { payloadType: 'text/plain' })] },
            'payload type is not',
        ],
        [
            'a payload that is no entry',
            { releases: [buildRelease('0.1.0', { entry: () => ({ v: 2 }) })] },
            'the payload is not a release entry',
        ],
        [
            'no ui artifact',
            {
                releases: [
                    buildRelease('0.1.0', {
                        entry: (entry) => ({
                            ...entry,
                            artifacts: [{ name: 'engine.tgz', sha256: 'a'.repeat(64), kind: 'engine' }],
                        }),
                    }),
                ],
            },
            'has no ui artifact',
        ],
        [
            'a first entry other than the manifest',
            { releases: [buildRelease('0.1.0', { firstEntry: 'index.html' })] },
            'the first entry is not manifest.json',
        ],
        [
            'a manifest that does not parse',
            { releases: [buildRelease('0.1.0', { manifest: () => ({ v: 1 }) })] },
            'is not a UiBundleManifest',
        ],
        [
            'a manifest of another commit',
            {
                releases: [
                    buildRelease('0.1.0', { manifest: (manifest) => ({ ...manifest, commit: 'd'.repeat(40) }) }),
                ],
            },
            "the manifest's version or commit differs",
        ],
    ] satisfies [string, WorldOptions, string][])('fails the release check on %s', async (_name, world, message) => {
        const { byId } = await run(world, { ownerCookie: null });
        expect(byId['staging.ui.release'].status).toBe('fail');
        expect(byId['staging.ui.release'].detail).toContain(message);
        expect(byId['staging.ui.release'].fix).toContain('https://ui.ptbk.link/');
    });

    it.each([
        [
            'an archive with another hash',
            (r: Request) => (r.url.endsWith('.tar.zst') ? new Response('junk') : undefined),
            'does not match the SHA-256',
        ],
        [
            'a missing archive',
            (r: Request) => (r.url.endsWith('.tar.zst') ? new Response(null, { status: 404 }) : undefined),
            'answered 404',
        ],
        [
            'an unreachable archive',
            (r: Request) => (r.url.endsWith('.tar.zst') ? Response.error() : undefined),
            'engine-ui.tar.zst:',
        ],
    ])('fails the release check on %s', async (_name, route, message) => {
        const { byId } = await run({ route }, { ownerCookie: null });
        expect(byId['staging.ui.release'].detail).toContain(message);
    });

    it.each([
        ['an archive that is not zstd', { archive: new TextEncoder().encode('plain') }, 'not a zstd frame'],
        ['a manifest that is not JSON', { manifestText: '{' }, 'manifest.json is not JSON'],
    ])('fails the release check on %s', async (_name, overrides, message) => {
        const { byId } = await run({ releases: [buildRelease('0.1.0', overrides)] }, { ownerCookie: null });
        expect(byId['staging.ui.release'].detail).toContain(message);
    });

    it.each([
        [
            'sign-in',
            'staging.gateway.sign-in',
            at('/auth/sign-in', () => html('', 404)),
            'GET /auth/sign-in answered 404, not 200',
        ],
        [
            'sign-in redirected',
            'staging.gateway.sign-in',
            at('/auth/sign-in', () => html('', 302, { Location: '/elsewhere' })),
            'answered 302 to /elsewhere',
        ],
        [
            'sign-in as JSON',
            'staging.gateway.sign-in',
            at('/auth/sign-in', () => Response.json({})),
            'answered 200 application/json',
        ],
        [
            'sign-in without a type',
            'staging.gateway.sign-in',
            at('/auth/sign-in', () => new Response(null)),
            'without a Content-Type',
        ],
        [
            'sign-in unreachable',
            'staging.gateway.sign-in',
            at('/auth/sign-in', () => Response.error()),
            'GET /auth/sign-in:',
        ],
        ['setup', 'staging.gateway.setup', at('/setup', () => html('', 404)), 'GET /setup answered 404'],
        [
            'an open UI',
            'staging.gateway.anonymous',
            at('/', () => html('<p>app</p>'), false),
            'GET / answered 200, not a redirect',
        ],
        [
            'a redirect elsewhere',
            'staging.gateway.anonymous',
            at(
                '/',
                () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/auth/sign-in' } }),
                false,
            ),
            'redirected to https://evil.test/auth/sign-in',
        ],
        ['an unreachable /', 'staging.gateway.anonymous', at('/', () => Response.error(), false), 'GET /:'],
        [
            'an open API',
            'staging.gateway.anonymous',
            at('/api/v1/engine', () => Response.json({}), false),
            'answered 200 application/json, not 401',
        ],
        [
            'an untyped 401',
            'staging.gateway.anonymous',
            at('/api/v1/engine', () => new Response(null, { status: 401 }), false),
            'answered 401 without a Content-Type',
        ],
        [
            'an unreachable API',
            'staging.gateway.anonymous',
            at('/api/v1/engine', () => Response.error(), false),
            'GET /api/v1/engine:',
        ],
        [
            'a loosened CSP on sign-in',
            'staging.headers.csp',
            at('/auth/sign-in', () => html('', 200, { 'Content-Security-Policy': 'default-src *' })),
            'other than ENGINE_UI_CSP: default-src *',
        ],
        [
            'no CSP on the app',
            'staging.headers.csp',
            at('/', () => new Response(new Uint8Array(0), { headers: { 'Content-Type': 'text/html' } }), true),
            'GET / (signed in) sends no Content-Security-Policy',
        ],
        [
            'a refused cookie',
            'staging.engine.info',
            at('/api/v1/engine', () => new Response(null, { status: 401 }), true),
            'answered 401 with the owner cookie',
        ],
        [
            'engine info that is not JSON',
            'staging.engine.info',
            at('/api/v1/engine', () => new Response('{', { status: 200 }), true),
            'is not JSON',
        ],
        [
            'engine info that fails',
            'staging.engine.info',
            at('/api/v1/engine', () => new Response(null, { status: 500 }), true),
            'answered 500',
        ],
        [
            'engine info off the contract',
            'staging.engine.info',
            at('/api/v1/engine', () => Response.json({}), true),
            'does not match the contract at name',
        ],
        [
            'a direct-mode engine under another name',
            'staging.engine.info',
            at(
                '/api/v1/engine',
                () =>
                    Response.json({
                        name: 'x',
                        engineId: null,
                        hostname: 'other.test',
                        dashboardUrl: null,
                        mode: 'direct',
                    }),
                true,
            ),
            'mode is direct, not tunnel; engineId is null, not ' + ENGINE_ID + '; hostname is other.test',
        ],
    ] as const)('fails on %s', async (_name, id, route, message) => {
        const { report, byId } = await run({ route });
        expect(report.ok).toBe(false);
        expect(byId[id].status).toBe('fail');
        expect(byId[id].detail).toContain(message);
        expect(byId[id].fix).toBeTruthy();
    });

    it('skips the CSP check when no page answered', async () => {
        const { byId } = await run({ route: at('/auth/sign-in', () => Response.error()) }, { ownerCookie: null });
        expect(byId['staging.headers.csp']).toMatchObject({
            status: 'skip',
            detail: 'no page answered to read the header from',
        });
    });

    it('stops reading a body past the cap', async () => {
        const huge = () => new Response(new Uint8Array(5 * 1024 * 1024));
        const { byId } = await run({ route: at('/auth/sign-in', huge) });
        expect(byId['staging.gateway.sign-in'].detail).toContain('the body is over');
    });

    it('fails DNS when the engine hostname resolves elsewhere than the relay', async () => {
        const { byId } = await run({ engineAddresses: ['203.0.113.7'] });
        expect(byId['staging.dns.via-relay'].status).toBe('fail');
        expect(byId['staging.dns.via-relay'].detail).toContain('203.0.113.7');
    });
});
