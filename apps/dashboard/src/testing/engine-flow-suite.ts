import {
    checkRegistrationResponse,
    ed25519PublicKeyToBytes,
    LinkCode,
    ProblemDetails,
    REGISTER_PATH,
    TolerantRegisterEngineResponse,
    type EngineId,
    type RegisterEngineRequest,
} from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { orgIdSchema } from '../domain/ids';
import { LINK_CODE_TTL_MS } from '../domain/registration/issue-link-code';
import type {
    BillingView,
    LinkCodeView,
    LinkEligibilityView,
    PendingLinkCodesView,
    SessionView,
} from '../shared/api/routes';
import { TEST_INSTALL_VARS } from './install-fixtures';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import { problemCode, signIn, signUp } from './auth-flows';
import { createTestEngine, TEST_ENGINE_DOMAIN, type TestEngine } from './test-engine';

const LINK_CODES = '/api/engines/link-codes';
const LINK_ELIGIBILITY = '/api/engines/link-eligibility';
const OTHER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';

async function orgOf(browser: TestBrowser) {
    const response = await browser.request('GET', '/api/session');
    return orgIdSchema.parse((response.body as SessionView).activeOrg.id);
}

function issued(response: TestResponse): LinkCodeView {
    expect(response.status).toBe(200);
    return response.body as LinkCodeView;
}

/**
 * D-03's acceptance tests over HTTP: link codes through the SPA's API and registration through `/v1`, with the engine
 * side done as M-06 does it (sign with `signRegistration`, read tolerantly, then `checkRegistrationResponse`). Runs on
 * the in-memory stores (unit project) and on D1 (workers project); `storedLinkCodeValues` returns every value of every
 * stored link-code row, as the store holds it.
 */
export function describeEngineFlows(
    name: string,
    makeHarness: () => AuthHarness,
    storedLinkCodeValues: (harness: AuthHarness) => Promise<readonly unknown[]>,
    /** What D-06's revocation will do to the engine's row. */
    revoke: (harness: AuthHarness, engineId: EngineId) => Promise<void>,
): void {
    describe(name, () => {
        let harness: AuthHarness;
        // One address per owner, so the per-IP signup limit never ties two owners together.
        let owners = 0;

        beforeEach(() => {
            harness = makeHarness();
            owners = 0;
        });

        async function owner(options: { readonly subscribed?: boolean } = {}) {
            owners++;
            const browser = harness.browser({ ip: `203.0.113.${String(owners)}` });
            await signUp(harness, browser);
            if (options.subscribed ?? true) {
                expect((await browser.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(
                    200,
                );
            }
            return { browser, orgId: await orgOf(browser) };
        }

        async function linkCode(browser: TestBrowser): Promise<LinkCode> {
            return LinkCode.parse(issued(await browser.request('POST', LINK_CODES)).linkCode);
        }

        function register(request: RegisterEngineRequest | Readonly<Record<string, unknown>>) {
            return harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request);
        }

        async function pending(browser: TestBrowser): Promise<PendingLinkCodesView> {
            const response = await browser.request('GET', LINK_CODES);
            expect(response.status).toBe(200);
            return response.body as PendingLinkCodesView;
        }

        function expectProblem(response: TestResponse, status: number, code: string): void {
            expect(response.status).toBe(status);
            expect(response.headers.get('Content-Type')).toBe('application/problem+json');
            expect(ProblemDetails.parse(response.body)).toMatchObject({ status, code });
        }

        async function expectRegistered(response: TestResponse, engine: TestEngine): Promise<void> {
            expect(response.status).toBe(200);
            expect(response.headers.get('Cache-Control')).toBe('no-store');
            const answer = TolerantRegisterEngineResponse.parse(response.body);
            expect(answer.relays).toEqual(['relay-1.ptbk.test']);
            expect(
                await checkRegistrationResponse(answer, ed25519PublicKeyToBytes(engine.publicKey), TEST_ENGINE_DOMAIN),
            ).toEqual({ kind: 'ok' });
        }

        it('needs a session to issue a link code', async () => {
            const response = await harness.browser().request('POST', LINK_CODES);
            expect([response.status, problemCode(response)]).toEqual([401, 'unauthorized']);
            expect(await storedLinkCodeValues(harness)).toEqual([]);
        });

        it('tells a signed-in owner where the install guide is, and nobody without a session', async () => {
            const { browser } = await owner();
            const answer = await browser.request('GET', '/api/install-guide');
            expect([answer.status, answer.body]).toEqual([200, { url: TEST_INSTALL_VARS.INSTALL_GUIDE_URL }]);
            const anonymous = await harness.browser().request('GET', '/api/install-guide');
            expect([anonymous.status, problemCode(anonymous)]).toEqual([401, 'unauthorized']);
        });

        it('issues a code inside the install command and registers an engine with it', async () => {
            const { browser } = await owner();
            const view = issued(await browser.request('POST', LINK_CODES));
            expect(LinkCode.parse(view.linkCode)).toBe(view.linkCode);
            expect(view.installCommands.map((path) => [path.id, path.labelKey, path.docsAnchor])).toEqual(
                TEST_INSTALL_VARS.INSTALL_COMMANDS.map((path) => [path.id, path.labelKey, path.docsAnchor]),
            );
            expect(view.installCommands.map((path) => path.command)).toEqual(
                TEST_INSTALL_VARS.INSTALL_COMMANDS.map((path) => path.template.replace('{linkCode}', view.linkCode)),
            );
            for (const { command } of view.installCommands) {
                expect(command.split(view.linkCode)).toHaveLength(2);
            }
            expect(view.installGuideUrl).toBe(TEST_INSTALL_VARS.INSTALL_GUIDE_URL);
            expect(view.expiresAt).toBe(harness.clock.nowMs() + LINK_CODE_TTL_MS);
            const engine = await createTestEngine();
            await expectRegistered(await register(await engine.register(LinkCode.parse(view.linkCode))), engine);
            expectProblem(
                await register(await engine.register(LinkCode.parse(view.linkCode))),
                401,
                'invalid-link-code',
            );
        });

        it('stores only a hash and never returns the code again', async () => {
            const { browser } = await owner();
            const code = await linkCode(browser);
            const values = await storedLinkCodeValues(harness);
            expect(values.length).toBeGreaterThan(0);
            for (const value of values) {
                expect(String(value)).not.toContain(code);
            }
            const reads = await Promise.all(
                ['/api/session', '/api/billing', '/api/sessions', '/api/passkeys'].map((path) =>
                    browser.request('GET', path),
                ),
            );
            for (const read of reads) {
                expect(read.status).toBe(200);
                expect(JSON.stringify(read.body)).not.toContain(code);
            }
            expect(await linkCode(browser)).not.toBe(code);
            expect(JSON.stringify(harness.logger.entries)).not.toContain(code);
        });

        it('links the engine to the issuing organization only', async () => {
            const a = await owner();
            const b = await owner();
            const engine = await createTestEngine();
            await expectRegistered(await register(await engine.register(await linkCode(b.browser))), engine);
            expect(await harness.deps.engines.countActive(b.orgId)).toBe(1);
            expect(await harness.deps.engines.countActive(a.orgId)).toBe(0);
            expect((await harness.deps.engines.findForRegistration(engine.engineId))?.orgId).toBe(b.orgId);
            const foreign = await linkCode(a.browser);
            expectProblem(await register(await engine.register(foreign)), 409, 'engine-exists');
            // The code stayed unused, so org A can still link another engine with it.
            const other = await createTestEngine();
            await expectRegistered(await register(await other.register(foreign)), other);
        });

        it('counts the organization’s own active engines against engines.max in the billing view', async () => {
            const engineUsage = async (browser: TestBrowser) => {
                const response = await browser.request('GET', '/api/billing');
                expect(response.status).toBe(200);
                return (response.body as BillingView).entitlements.quotas.find(({ quota }) => quota === 'engines.max');
            };
            const a = await owner();
            const b = await owner();
            expect(await engineUsage(b.browser)).toEqual({ quota: 'engines.max', limit: 2, used: 0 });
            const first = await createTestEngine();
            const second = await createTestEngine();
            await expectRegistered(await register(await first.register(await linkCode(b.browser))), first);
            await expectRegistered(await register(await second.register(await linkCode(b.browser))), second);
            expect(await engineUsage(b.browser)).toEqual({ quota: 'engines.max', limit: 2, used: 2 });
            expect(await engineUsage(a.browser)).toEqual({ quota: 'engines.max', limit: 2, used: 0 });
            await revoke(harness, first.engineId);
            expect((await engineUsage(b.browser))?.used).toBe(1);
        });

        it('re-registers the same key from the same organization idempotently', async () => {
            const { browser, orgId } = await owner();
            const engine = await createTestEngine();
            const first = await register(await engine.register(await linkCode(browser)));
            const second = await register(
                await engine.register(await linkCode(browser), { engineVersion: '2.0.0', mode: 'direct' }),
            );
            expect(second.body).toEqual(first.body);
            expect(await harness.deps.engines.countActive(orgId)).toBe(1);
            expect(await harness.deps.engines.findForRegistration(engine.engineId)).toMatchObject({
                engineVersion: '2.0.0',
                mode: 'direct',
            });
        });

        it('refuses a forged signature and a tampered mode, leaving the code usable', async () => {
            const { browser } = await owner();
            const code = await linkCode(browser);
            const engine = await createTestEngine();
            const signed = await engine.register(code);
            const forged = { ...signed, sig: (await (await createTestEngine()).register(code)).sig };
            expectProblem(await register(forged), 401, 'bad-signature');
            expectProblem(await register({ ...signed, mode: 'direct' }), 401, 'bad-signature');
            await expectRegistered(await register(signed), engine);
        });

        it('shows the upgrade path before an install command', async () => {
            const unsubscribed = await owner({ subscribed: false });
            const denied = await unsubscribed.browser.request('POST', LINK_CODES);
            expect([denied.status, problemCode(denied)]).toEqual([403, 'not-entitled']);
            const { browser } = await owner();
            for (let i = 0; i < 2; i++) {
                const engine = await createTestEngine();
                await expectRegistered(await register(await engine.register(await linkCode(browser))), engine);
            }
            const atLimit = await browser.request('POST', LINK_CODES);
            expect([atLimit.status, problemCode(atLimit)]).toEqual([403, 'engine-limit']);
        });

        it('refuses a new engine over the quota and a revoked engine at registration, keeping the codes', async () => {
            const { browser } = await owner();
            // Issued before the quota fills: issuance checks it too.
            const [a, b, spare] = [await linkCode(browser), await linkCode(browser), await linkCode(browser)];
            const first = await createTestEngine();
            const second = await createTestEngine();
            await expectRegistered(await register(await first.register(a)), first);
            await expectRegistered(await register(await second.register(b)), second);
            expectProblem(await register(await (await createTestEngine()).register(spare)), 403, 'engine-limit');
            await revoke(harness, first.engineId);
            expectProblem(await register(await first.register(spare)), 403, 'engine-suspended');
            await expectRegistered(await register(await second.register(spare)), second);
        });

        it('limits active link codes per organization until one is cancelled', async () => {
            const { browser } = await owner();
            for (let i = 0; i < 5; i++) {
                await linkCode(browser);
            }
            const limited = await browser.request('POST', LINK_CODES);
            expect([limited.status, problemCode(limited)]).toEqual([409, 'link-code-limit']);
            const [oldest] = (await pending(browser)).linkCodes.slice(-1);
            expect((await browser.request('POST', `${LINK_CODES}/${oldest?.linkCodeId ?? ''}/cancel`)).status).toBe(
                204,
            );
            expect((await browser.request('POST', LINK_CODES)).status).toBe(200);
        });

        describe('pending codes', () => {
            it('lists the organization’s unused codes, newest first, without the code', async () => {
                const { browser } = await owner();
                expect(await pending(browser)).toEqual({ linkCodes: [] });
                const first = issued(await browser.request('POST', LINK_CODES));
                harness.clock.advance(1000);
                const second = issued(await browser.request('POST', LINK_CODES));
                const used = issued(await browser.request('POST', LINK_CODES));
                const engine = await createTestEngine();
                await expectRegistered(await register(await engine.register(LinkCode.parse(used.linkCode))), engine);
                const response = await browser.request('GET', LINK_CODES);
                expect([response.status, response.headers.get('Cache-Control')]).toEqual([200, 'no-store']);
                expect(response.body).toEqual({
                    linkCodes: [second, first].map((view) => ({
                        linkCodeId: view.linkCodeId,
                        createdAt: view.expiresAt - LINK_CODE_TTL_MS,
                        expiresAt: view.expiresAt,
                    })),
                });
                for (const view of [first, second]) {
                    expect(JSON.stringify(response.body)).not.toContain(view.linkCode);
                }
                expect((await pending((await owner()).browser)).linkCodes).toEqual([]);
            });

            it('cancels a code so no engine can link with it, and the link page reads it as expired', async () => {
                const { browser } = await owner();
                const view = issued(await browser.request('POST', LINK_CODES));
                const cancel = await browser.request('POST', `${LINK_CODES}/${view.linkCodeId}/cancel`);
                expect(cancel.status).toBe(204);
                expect((await browser.request('GET', `${LINK_CODES}/${view.linkCodeId}`)).body).toEqual({
                    status: 'expired',
                });
                expect((await pending(browser)).linkCodes).toEqual([]);
                const engine = await createTestEngine();
                expectProblem(
                    await register(await engine.register(LinkCode.parse(view.linkCode))),
                    401,
                    'invalid-link-code',
                );
                const again = await browser.request('POST', `${LINK_CODES}/${view.linkCodeId}/cancel`);
                expect([again.status, problemCode(again)]).toEqual([404, 'not-found']);
            });

            it('cancels neither a used code, nor another organization’s, nor an unknown one', async () => {
                const a = await owner();
                const b = await owner();
                const used = issued(await a.browser.request('POST', LINK_CODES));
                const engine = await createTestEngine();
                await expectRegistered(await register(await engine.register(LinkCode.parse(used.linkCode))), engine);
                const foreign = issued(await a.browser.request('POST', LINK_CODES));
                for (const [browser, id] of [
                    [a.browser, used.linkCodeId],
                    [b.browser, foreign.linkCodeId],
                    [a.browser, OTHER_ID],
                ] as const) {
                    const response = await browser.request('POST', `${LINK_CODES}/${id}/cancel`);
                    expect([response.status, problemCode(response)]).toEqual([404, 'not-found']);
                }
                expect((await a.browser.request('GET', `${LINK_CODES}/${foreign.linkCodeId}`)).body).toMatchObject({
                    status: 'pending',
                });
                expect((await a.browser.request('POST', `${LINK_CODES}/not-an-id/cancel`)).status).toBe(400);
            });

            it('needs a session to list or cancel codes', async () => {
                const { browser } = await owner();
                const view = issued(await browser.request('POST', LINK_CODES));
                const anonymous = harness.browser();
                for (const response of [
                    await anonymous.request('GET', LINK_CODES),
                    await anonymous.request('POST', `${LINK_CODES}/${view.linkCodeId}/cancel`),
                ]) {
                    expect([response.status, problemCode(response)]).toEqual([401, 'unauthorized']);
                }
                expect((await pending(browser)).linkCodes).toHaveLength(1);
            });
        });

        describe('link page (D-10)', () => {
            async function eligibility(browser: TestBrowser): Promise<LinkEligibilityView> {
                const response = await browser.request('GET', LINK_ELIGIBILITY);
                expect(response.status).toBe(200);
                return response.body as LinkEligibilityView;
            }

            async function status(browser: TestBrowser, linkCodeId: string): Promise<TestResponse> {
                return browser.request('GET', `${LINK_CODES}/${linkCodeId}`);
            }

            it('says before any code whether the organization may link, with the code lifetime', async () => {
                const unsubscribed = await owner({ subscribed: false });
                expect(await eligibility(unsubscribed.browser)).toEqual({
                    eligibility: 'not-entitled',
                    linkCodeTtlS: LINK_CODE_TTL_MS / 1000,
                    installGuideUrl: TEST_INSTALL_VARS.INSTALL_GUIDE_URL,
                });
                const { browser } = await owner();
                expect((await eligibility(browser)).eligibility).toBe('allowed');
                for (let i = 0; i < 2; i++) {
                    const engine = await createTestEngine();
                    await expectRegistered(await register(await engine.register(await linkCode(browser))), engine);
                }
                expect((await eligibility(browser)).eligibility).toBe('engine-limit');
                const busy = await owner();
                for (let i = 0; i < 5; i++) {
                    await linkCode(busy.browser);
                }
                // The rate limit is issuance's answer, not the plan step's.
                expect((await eligibility(busy.browser)).eligibility).toBe('allowed');
            });

            it('follows a code from pending to expired, or to linked with the engine, without the code', async () => {
                const { browser } = await owner();
                const view = issued(await browser.request('POST', LINK_CODES));
                expect(view.linkCodeId).toMatch(/^[a-z2-7]{26}$/);
                const pending = await status(browser, view.linkCodeId);
                expect([pending.status, pending.headers.get('Cache-Control')]).toEqual([200, 'no-store']);
                expect(pending.body).toEqual({ status: 'pending', expiresAt: view.expiresAt });

                const engine = await createTestEngine();
                const request = await engine.register(LinkCode.parse(view.linkCode));
                await expectRegistered(await register(request), engine);
                const linked = await status(browser, view.linkCodeId);
                expect(linked.body).toEqual({
                    status: 'linked',
                    engineId: engine.engineId,
                    hostname: `${engine.engineId}.${TEST_ENGINE_DOMAIN}`,
                });
                // An engine whose answer was lost retries with the spent code and is refused; the page still sees it.
                expectProblem(await register(request), 401, 'invalid-link-code');
                // A code outlives the session that issued it, so the owner signs in again after each wait.
                harness.clock.advance(LINK_CODE_TTL_MS + 1000);
                expect((await signIn(browser)).verify.status).toBe(200);
                expect((await status(browser, view.linkCodeId)).body).toMatchObject({ status: 'linked' });

                const unused = issued(await browser.request('POST', LINK_CODES));
                harness.clock.advance(LINK_CODE_TTL_MS);
                expect((await signIn(browser)).verify.status).toBe(200);
                expect((await status(browser, unused.linkCodeId)).body).toEqual({ status: 'expired' });
                for (const body of [pending.body, linked.body]) {
                    expect(JSON.stringify(body)).not.toContain(view.linkCode);
                }
            });

            it('answers 404 for another organization’s code and an unknown one, and 401 without a session', async () => {
                const a = await owner();
                const b = await owner();
                const view = issued(await a.browser.request('POST', LINK_CODES));
                for (const response of [await status(b.browser, view.linkCodeId), await status(a.browser, OTHER_ID)]) {
                    expect([response.status, problemCode(response)]).toEqual([404, 'not-found']);
                }
                const malformed = await status(a.browser, 'not-an-id');
                expect(malformed.status).toBe(400);
                const anonymous = harness.browser();
                for (const response of [
                    await status(anonymous, view.linkCodeId),
                    await anonymous.request('GET', LINK_ELIGIBILITY),
                ]) {
                    expect([response.status, problemCode(response)]).toEqual([401, 'unauthorized']);
                }
            });
        });
    });
}
