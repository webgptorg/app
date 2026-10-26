import {
    defaultHostname,
    ed25519SignatureFromBytes,
    heartbeatPath,
    Hostname,
    LinkCode,
    REGISTER_PATH,
    RegistryEntry,
    registryPath,
    signHostnameClaim,
    type EngineId,
} from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import { STEP_UP_WINDOW_MS } from '../domain/authz/authorizer';
import type { AdminAuditEntry } from '../domain/auth/records';
import { newRelayToken, sha256Hex } from '../domain/auth/secrets';
import { newRelayTokenId } from '../domain/ids';
import type { AdminEngineView, EngineView, LinkCodeView } from '../shared/api/routes';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import { problemCode, requestOptions, signUp } from './auth-flows';
import type { StoredRelayToken } from './memory-registry-stores';
import { createTestEngine, TEST_ENGINE_DOMAIN, type TestEngine } from './test-engine';
import { signedHeartbeat } from './test-heartbeat';

const RELAY = 'relay-1.ptbk.test';
const DAY_MS = 24 * 60 * 60 * 1000;
const REASON = 'Phishing report #42, confirmed from the public page';

export interface EngineSuspensionFlowFixture {
    readonly harness: AuthHarness;
    /** What `scripts/make-admin.md` does on this store. */
    makeAdmin(email: string): Promise<void>;
    /** Writes the row as `scripts/mint-relay-key.ts` does. */
    addRelayToken(row: StoredRelayToken): Promise<void>;
    /** Every `admin_audit_log` entry whose target is the engine itself, oldest first. */
    engineAudit(engineId: EngineId): Promise<readonly AdminAuditEntry[]>;
}

/**
 * I-05's acceptance tests over HTTP: a platform admin suspends an engine and lifts the suspension, and the registry,
 * registration, heartbeats and the owner's view follow. Runs on the in-memory stores (unit project) and on D1 (workers
 * project).
 */
export function describeEngineSuspensionFlows(name: string, makeFixture: () => EngineSuspensionFlowFixture): void {
    describe(name, () => {
        let fixture: EngineSuspensionFlowFixture;
        let harness: AuthHarness;
        let people = 0;
        let owner: TestBrowser;
        let engine: TestEngine;

        async function person(): Promise<{ readonly browser: TestBrowser; readonly email: string }> {
            people++;
            const browser = harness.browser({ ip: `203.0.113.${String(people)}` });
            const { email } = await signUp(harness, browser);
            return { browser, email };
        }

        async function stepUp(browser: TestBrowser): Promise<void> {
            const options = requestOptions(await browser.request('POST', '/api/auth/step-up/options'));
            const response = await browser.authenticator.assert(options);
            expect((await browser.request('POST', '/api/auth/step-up/verify', { response })).status).toBe(200);
        }

        async function admin(options: { readonly steppedUp: boolean } = { steppedUp: true }): Promise<TestBrowser> {
            const { browser, email } = await person();
            await fixture.makeAdmin(email);
            if (options.steppedUp) {
                await stepUp(browser);
            }
            return browser;
        }

        async function register(target: TestEngine): Promise<TestResponse> {
            const view = (await owner.request('POST', '/api/engines/link-codes')).body as LinkCodeView;
            const request = await target.register(LinkCode.parse(view.linkCode));
            return harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request);
        }

        async function registry(engineId: EngineId): Promise<RegistryEntry> {
            const token = newRelayToken(cryptoRandom);
            const now = harness.clock.nowMs();
            await fixture.addRelayToken({
                id: newRelayTokenId(cryptoRandom),
                relayId: RELAY,
                tokenHash: await sha256Hex(token),
                createdAt: now,
                expiresAt: now + 365 * DAY_MS,
                lastUsedAt: null,
                revokedAt: null,
            });
            const response = await harness
                .browser({ ip: '192.0.2.50' })
                .request('GET', registryPath(engineId), undefined, { Authorization: `Bearer ${token}` });
            expect(response.status).toBe(200);
            return RegistryEntry.parse(response.body);
        }

        function suspend(browser: TestBrowser, reason = REASON): Promise<TestResponse> {
            return browser.request('POST', `/api/admin/engines/${engine.engineId}/suspend`, { reason });
        }

        function unsuspend(browser: TestBrowser, reason = 'Appeal accepted'): Promise<TestResponse> {
            return browser.request('POST', `/api/admin/engines/${engine.engineId}/unsuspend`, { reason });
        }

        async function ownerView(): Promise<EngineView> {
            return ((await owner.request('GET', `/api/engines/${engine.engineId}`)).body as { engine: EngineView })
                .engine;
        }

        function expectProblem(response: TestResponse, status: number, code: string): void {
            expect([response.status, problemCode(response)]).toEqual([status, code]);
        }

        beforeEach(async () => {
            fixture = makeFixture();
            harness = fixture.harness;
            people = 0;
            owner = (await person()).browser;
            expect((await owner.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(200);
            engine = await createTestEngine();
            expect((await register(engine)).status).toBe(200);
        });

        it('shows any organization’s engine to a platform admin, and to nobody else', async () => {
            const response = await (
                await admin({ steppedUp: false })
            ).request('GET', `/api/admin/engines/${engine.engineId}`);
            expect(response.status).toBe(200);
            expect((response.body as { engine: AdminEngineView }).engine).toMatchObject({
                engineId: engine.engineId,
                hostname: defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN),
                status: 'active',
                suspendedBy: null,
            });
            expectProblem(await owner.request('GET', `/api/admin/engines/${engine.engineId}`), 403, 'forbidden');
            const unknown = await createTestEngine();
            expectProblem(
                await (await admin()).request('GET', `/api/admin/engines/${unknown.engineId}`),
                404,
                'not-found',
            );
        });

        it('lets only a platform admin with a fresh step-up suspend, and writes nothing otherwise', async () => {
            expectProblem(await suspend(owner), 403, 'forbidden');
            const notSteppedUp = await admin({ steppedUp: false });
            expectProblem(await suspend(notSteppedUp), 403, 'step-up-required');
            await stepUp(notSteppedUp);
            harness.clock.advance(STEP_UP_WINDOW_MS + 1);
            expectProblem(await suspend(notSteppedUp), 403, 'step-up-required');
            expect(await fixture.engineAudit(engine.engineId)).toEqual([]);
            expect((await registry(engine.engineId)).status).toBe('active');
        });

        it('requires a reason', async () => {
            const browser = await admin();
            for (const reason of ['', '   ', 'x'.repeat(501)]) {
                expectProblem(await suspend(browser, reason), 400, 'invalid-request');
            }
            expectProblem(
                await browser.request('POST', `/api/admin/engines/${engine.engineId}/suspend`, {}),
                400,
                'invalid-request',
            );
            expect(await fixture.engineAudit(engine.engineId)).toEqual([]);
        });

        it('suspends with one audit row; the registry, registration, heartbeats and the owner follow', async () => {
            const hostname = Hostname.parse('agents.customer.test');
            const sig = ed25519SignatureFromBytes(await signHostnameClaim(engine.signer, hostname, engine.engineId));
            harness.engineHostnames.set(engine.engineId, [{ hostname, sig }]);
            expect((await registry(engine.engineId)).hostnames).toContain(hostname);

            const browser = await admin();
            const response = await suspend(browser);
            expect(response.status).toBe(200);
            expect((response.body as { engine: AdminEngineView }).engine).toMatchObject({
                status: 'suspended',
                suspendedBy: 'platform',
            });
            const [entry, ...rest] = await fixture.engineAudit(engine.engineId);
            expect(rest).toEqual([]);
            expect(entry).toMatchObject({
                action: 'admin.engine.suspend',
                targetType: 'engine',
                targetId: engine.engineId,
                reason: REASON,
                createdAt: harness.clock.nowMs(),
            });

            expect(await registry(engine.engineId)).toEqual({
                enginePublicKey: engine.publicKey,
                hostnames: [defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN)],
                claims: [],
                status: 'suspended',
            });
            expectProblem(await register(engine), 403, 'engine-suspended');
            const heartbeat = await signedHeartbeat(engine, 1, harness.clock.nowMs());
            expectProblem(
                await harness.post(heartbeatPath(engine.engineId), heartbeat.body, heartbeat.headers),
                403,
                'engine-suspended',
            );
            expect(await ownerView()).toMatchObject({ status: 'suspended', suspendedBy: 'platform' });

            // Suspending again changes nothing and logs nothing.
            expect((await suspend(browser)).status).toBe(200);
            expect(await fixture.engineAudit(engine.engineId)).toHaveLength(1);
        });

        it('lifts a platform suspension with its own audit row', async () => {
            const browser = await admin();
            expect((await suspend(browser)).status).toBe(200);
            harness.clock.advance(1000);
            const response = await unsuspend(browser);
            expect(response.status).toBe(200);
            expect((response.body as { engine: AdminEngineView }).engine).toMatchObject({
                status: 'active',
                suspendedBy: null,
            });
            expect((await fixture.engineAudit(engine.engineId)).map((entry) => [entry.action, entry.reason])).toEqual([
                ['admin.engine.suspend', REASON],
                ['admin.engine.unsuspend', 'Appeal accepted'],
            ]);
            expect((await registry(engine.engineId)).status).toBe('active');
            expect((await register(engine)).status).toBe(200);
            expect(await ownerView()).toMatchObject({ suspendedBy: null });

            // An active engine has nothing to lift.
            expect((await unsuspend(browser)).status).toBe(200);
            expect(await fixture.engineAudit(engine.engineId)).toHaveLength(2);
        });

        it('never lifts an owner revocation', async () => {
            await stepUp(owner);
            expect((await owner.request('POST', `/api/engines/${engine.engineId}/revoke`)).status).toBe(200);
            const browser = await admin();
            expectProblem(await unsuspend(browser), 409, 'owner-revoked');
            expect((await suspend(browser)).body).toMatchObject({
                engine: { status: 'suspended', suspendedBy: 'owner' },
            });
            expectProblem(await unsuspend(browser), 409, 'owner-revoked');
            expect(await fixture.engineAudit(engine.engineId)).toEqual([]);
            expect((await registry(engine.engineId)).status).toBe('suspended');
            expectProblem(await register(engine), 403, 'engine-suspended');
            expect(await ownerView()).toMatchObject({ status: 'suspended', suspendedBy: 'owner' });
        });

        it('keeps an engine revoked that its owner revoked while the platform had it suspended', async () => {
            const browser = await admin();
            expect((await suspend(browser)).status).toBe(200);
            await stepUp(owner);
            expect((await owner.request('POST', `/api/engines/${engine.engineId}/revoke`)).status).toBe(200);
            expectProblem(await unsuspend(browser), 409, 'owner-revoked');
            expect((await registry(engine.engineId)).status).toBe('suspended');
            expect((await fixture.engineAudit(engine.engineId)).map((entry) => entry.action)).toEqual([
                'admin.engine.suspend',
            ]);
        });

        it('answers 404 for an engine that does not exist', async () => {
            const browser = await admin();
            const unknown = await createTestEngine();
            for (const action of ['suspend', 'unsuspend']) {
                expectProblem(
                    await browser.request('POST', `/api/admin/engines/${unknown.engineId}/${action}`, { reason: 'x' }),
                    404,
                    'not-found',
                );
            }
        });
    });
}
