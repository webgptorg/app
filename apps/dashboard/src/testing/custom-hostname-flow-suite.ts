import {
    defaultHostname,
    expectedCnameTarget,
    Hostname,
    LinkCode,
    REGISTER_PATH,
    RegistryEntry,
    registryPath,
    type EngineId,
} from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import { newRelayToken, sha256Hex } from '../domain/auth/secrets';
import type { AdminAuditEntry } from '../domain/auth/records';
import { newRelayTokenId } from '../domain/ids';
import type { LinkCodeView, SessionView } from '../shared/api/routes';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import { problemCode, requestOptions, signUp } from './auth-flows';
import type { StoredRelayToken } from './memory-registry-stores';
import { signClaim } from './test-custom-hostnames';
import { createTestEngine, TEST_ENGINE_DOMAIN, type TestEngine } from './test-engine';

const RELAY = 'relay-1.ptbk.test';
const STEP_UP_MS = 5 * 60 * 1000;

export interface CustomHostnameFlowFixture {
    readonly harness: AuthHarness;
    /** What `scripts/make-admin.md` does on this store. */
    makeAdmin(email: string): Promise<void>;
    /** Writes the row as `scripts/mint-relay-key.ts` does. */
    addRelayToken(row: StoredRelayToken): Promise<void>;
    /** Every `admin_audit_log` entry about one of the engine's hostnames. */
    auditFor(engineId: EngineId): Promise<readonly AdminAuditEntry[]>;
}

/**
 * D-08's acceptance tests over HTTP: a platform admin attaches, DNS-checks and removes an engine's custom hostname,
 * and the registry relays read follows. Runs on the in-memory stores (unit project) and on D1 (workers project).
 */
export function describeCustomHostnameFlows(name: string, makeFixture: () => CustomHostnameFlowFixture): void {
    describe(name, () => {
        let fixture: CustomHostnameFlowFixture;
        let harness: AuthHarness;
        let owner: TestBrowser;
        let engine: TestEngine;
        let people = 0;
        /** Unique per test: the workers project keeps one D1 database for the whole file. */
        let customHostname = '';

        const base = () => `/api/admin/engines/${engine.engineId}/hostnames`;

        async function person(): Promise<{ readonly browser: TestBrowser; readonly email: string }> {
            people++;
            const browser = harness.browser({ ip: `203.0.113.${String(people)}` });
            const { email } = await signUp(harness, browser);
            return { browser, email };
        }

        async function admin(): Promise<TestBrowser> {
            const { browser, email } = await person();
            await fixture.makeAdmin(email);
            return browser;
        }

        async function stepUp(browser: TestBrowser): Promise<void> {
            const authentication = requestOptions(await browser.request('POST', '/api/auth/step-up/options'));
            const response = await browser.authenticator.assert(authentication);
            expect((await browser.request('POST', '/api/auth/step-up/verify', { response })).status).toBe(200);
        }

        async function steppedUpAdmin(): Promise<TestBrowser> {
            const browser = await admin();
            await stepUp(browser);
            return browser;
        }

        async function registry(): Promise<RegistryEntry> {
            const token = newRelayToken(cryptoRandom);
            const now = harness.clock.nowMs();
            await fixture.addRelayToken({
                id: newRelayTokenId(cryptoRandom),
                relayId: RELAY,
                tokenHash: await sha256Hex(token),
                createdAt: now,
                expiresAt: now + STEP_UP_MS * 1000,
                lastUsedAt: null,
                revokedAt: null,
            });
            const response = await harness
                .browser({ ip: '192.0.2.50' })
                .request('GET', registryPath(engine.engineId), undefined, { Authorization: `Bearer ${token}` });
            expect(response.status).toBe(200);
            return RegistryEntry.parse(response.body);
        }

        /** Signed over the hostname as stored, or over the test's hostname for one that cannot be. */
        async function add(browser: TestBrowser, hostname = customHostname, signer = engine): Promise<TestResponse> {
            const stored = Hostname.safeParse(hostname.replace(/\.$/, ''));
            return browser.request('POST', base(), {
                hostname,
                claimSig: await signClaim(signer, stored.success ? stored.data : customHostname, engine.engineId),
            });
        }

        const check = (browser: TestBrowser, hostname = customHostname) =>
            browser.request('POST', `${base()}/${hostname}/check`);
        const remove = (browser: TestBrowser, hostname = customHostname) =>
            browser.request('POST', `${base()}/${hostname}/remove`);

        function expectProblem(response: TestResponse, status: number, code: string): void {
            expect([response.status, problemCode(response)]).toEqual([status, code]);
        }

        beforeEach(async () => {
            fixture = makeFixture();
            harness = fixture.harness;
            people = 0;
            ({ browser: owner } = await person());
            expect((await owner.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(200);
            const view = (await owner.request('POST', '/api/engines/link-codes')).body as LinkCodeView;
            engine = await createTestEngine();
            customHostname = `agents.${engine.engineId}.customer.example`;
            const request = await engine.register(LinkCode.parse(view.linkCode));
            expect((await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request)).status).toBe(
                200,
            );
        });

        it('answers 401 without a session and 403 to anyone who is not a platform admin', async () => {
            const anonymous = harness.browser();
            const { browser: stranger } = await person();
            await stepUp(stranger);
            for (const browser of [anonymous, owner, stranger]) {
                const expected = browser === anonymous ? [401, 'unauthorized'] : [403, 'forbidden'];
                for (const response of [
                    await browser.request('GET', base()),
                    await add(browser),
                    await check(browser),
                    await remove(browser),
                ]) {
                    expect([response.status, problemCode(response)]).toEqual(expected);
                }
            }
            expect(await fixture.auditFor(engine.engineId)).toEqual([]);
        });

        it('needs a step-up within five minutes for every change, not for the list', async () => {
            const browser = await admin();
            expect((await browser.request('GET', base())).status).toBe(200);
            expectProblem(await add(browser), 403, 'step-up-required');
            expectProblem(await check(browser), 403, 'step-up-required');
            expectProblem(await remove(browser), 403, 'step-up-required');
            await stepUp(browser);
            expect((await add(browser)).status).toBe(200);
            harness.clock.advance(STEP_UP_MS + 1);
            expectProblem(await check(browser), 403, 'step-up-required');
            expectProblem(await remove(browser), 403, 'step-up-required');
            expect((await fixture.auditFor(engine.engineId)).map((entry) => entry.action)).toEqual([
                'engine.hostname.add',
            ]);
        });

        it('adds, activates on the right CNAME only, serves it to relays, and removes it, auditing each change', async () => {
            const browser = await steppedUpAdmin();
            const session = (await browser.request('GET', '/api/session')).body as SessionView;
            const hostname = Hostname.parse(customHostname);
            const target = expectedCnameTarget(engine.engineId, TEST_ENGINE_DOMAIN);

            const added = await add(browser, `${customHostname.toUpperCase()}.`);
            expect(added.body).toEqual({
                hostname: { hostname, status: 'pending-dns', dnsCheckedAt: null, createdAt: harness.clock.nowMs() },
            });
            const ownerOrg = ((await owner.request('GET', '/api/session')).body as SessionView).activeOrg.id;
            expect((await browser.request('GET', base())).body).toEqual({
                engineId: engine.engineId,
                orgId: ownerOrg,
                expectedTarget: target,
                hostnames: [{ hostname, status: 'pending-dns', dnsCheckedAt: null, createdAt: harness.clock.nowMs() }],
            });
            expect((await registry()).hostnames).toEqual([defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN)]);

            harness.dns.setAnswer(hostname, { kind: 'cname', target: Hostname.parse(RELAY) });
            const wrong = await check(browser);
            expect(wrong.body).toMatchObject({
                hostname: { status: 'pending-dns', dnsCheckedAt: harness.clock.nowMs() },
                lookup: { kind: 'cname', target: RELAY },
            });
            harness.dns.setAnswer(hostname, { kind: 'none' });
            expect((await check(browser)).body).toMatchObject({
                hostname: { status: 'pending-dns' },
                lookup: { kind: 'none' },
            });
            expect((await registry()).claims).toEqual([]);

            harness.dns.setAnswer(hostname, { kind: 'cname', target });
            harness.clock.advance(1000);
            expect((await check(browser)).body).toMatchObject({
                hostname: { status: 'active', dnsCheckedAt: harness.clock.nowMs() },
                lookup: { kind: 'cname', target },
            });
            const sig = await signClaim(engine, customHostname, engine.engineId);
            expect(await registry()).toMatchObject({
                hostnames: [defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN), hostname],
                claims: [{ hostname, sig }],
            });

            expect((await remove(browser)).status).toBe(200);
            expect(await registry()).toMatchObject({
                hostnames: [defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN)],
                claims: [],
            });
            expect((await browser.request('GET', base())).body).toMatchObject({ hostnames: [] });
            expectProblem(await remove(browser), 404, 'not-found');

            const audit = await fixture.auditFor(engine.engineId);
            expect(audit.map((entry) => [entry.action, entry.adminUserId, entry.targetType, entry.targetId])).toEqual(
                ['engine.hostname.add', 'engine.hostname.activate', 'engine.hostname.remove'].map((action) => [
                    action,
                    session.user.id,
                    'engine-hostname',
                    `${engine.engineId}/${customHostname}`,
                ]),
            );
        });

        it('refuses bad input with a code the page can explain', async () => {
            const browser = await steppedUpAdmin();
            expectProblem(await add(browser, '*.customer.example'), 400, 'invalid-hostname');
            expectProblem(await add(browser, `agents.${TEST_ENGINE_DOMAIN}`), 400, 'reserved-domain');
            expectProblem(await add(browser, 'app.ptbk.io'), 400, 'reserved-domain');
            expectProblem(await add(browser, customHostname, await createTestEngine()), 400, 'bad-claim');
            expect((await add(browser)).status).toBe(200);
            expectProblem(await add(browser), 409, 'taken');
            const claimSig = await signClaim(engine, customHostname, engine.engineId);
            expectProblem(
                await browser.request('POST', base(), { hostname: customHostname, claimSig: 'not-a-signature' }),
                400,
                'invalid-request',
            );
            expectProblem(
                await browser.request('POST', base(), { hostname: customHostname, claimSig, orgId: 'x' }),
                400,
                'invalid-request',
            );
            const unknown = (await createTestEngine()).engineId;
            expectProblem(
                await browser.request('POST', `/api/admin/engines/${unknown}/hostnames`, {
                    hostname: customHostname,
                    claimSig,
                }),
                404,
                'not-found',
            );
            expectProblem(await browser.request('GET', `/api/admin/engines/${unknown}/hostnames`), 404, 'not-found');
            expectProblem(await check(browser, 'portal.customer.example'), 404, 'not-found');
            expectProblem(await check(browser, 'Not_A_Hostname'), 400, 'invalid-request');
            expect(await fixture.auditFor(engine.engineId)).toHaveLength(1);
        });
    });
}
