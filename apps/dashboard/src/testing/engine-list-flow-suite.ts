import { heartbeatPath, LinkCode, REGISTER_PATH, type EngineId, type HostnameClaim } from '@ptbk/protocol';
import { ed25519SignatureFromBytes, Hostname } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { RECOVERY_COOLDOWN_MS, STEP_UP_WINDOW_MS, type PolicyTable } from '../domain/authz/authorizer';
import { orgIdSchema } from '../domain/ids';
import { DASHBOARD_POLICY, type DashboardAction } from '../domain/authz/policy';
import type { EngineStatusDirectory } from '../domain/status/engine-status-directory';
import type { EngineView, LinkCodeView, SessionView } from '../shared/api/routes';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import { problemCode, registerWith, requestOptions, requestRecovery, signUp } from './auth-flows';
import type { StoredOrgAuditEntry } from './memory-registration-store';
import { createTestEngine, TEST_ENGINE_DOMAIN, type TestEngine } from './test-engine';
import { signedHeartbeat } from './test-heartbeat';

const ENGINES = '/api/engines';
const MINUTE_MS = 60_000;

export interface EngineListHarnessOptions {
    readonly wrapEngineStatus?: (statuses: EngineStatusDirectory) => EngineStatusDirectory;
    readonly policy?: PolicyTable<DashboardAction>;
}

export interface EngineListFlowFixture {
    readonly harness: AuthHarness;
    /** The organization's `org_audit_log` rows; the repository itself has no read. */
    orgAudit(
        orgId: string,
    ): Promise<readonly Pick<StoredOrgAuditEntry, 'orgId' | 'actorUserId' | 'action' | 'targetType' | 'targetId'>[]>;
}

/** A status directory whose `getStatus` never answers for the engines in `stalled`. */
function stalling(stalled: Set<EngineId>, asked: EngineId[]) {
    return (statuses: EngineStatusDirectory): EngineStatusDirectory => ({
        ...statuses,
        getStatus(engineId) {
            asked.push(engineId);
            return stalled.has(engineId) ? new Promise(() => undefined) : statuses.getStatus(engineId);
        },
    });
}

/**
 * D-06's acceptance tests over HTTP: the engine list, an engine's page and its revocation through the SPA's API, with
 * engines registering and sending heartbeats as M-06 does. Runs on the in-memory stores (unit project) and on D1
 * (workers project); the status objects run in process, as in the heartbeat suite.
 */
export function describeEngineListFlows(
    name: string,
    makeFixture: (options: EngineListHarnessOptions) => EngineListFlowFixture,
): void {
    describe(name, () => {
        let fixture: EngineListFlowFixture;
        let harness: AuthHarness;
        let owners = 0;

        function setUp(options: EngineListHarnessOptions = {}): void {
            fixture = makeFixture(options);
            harness = fixture.harness;
        }

        beforeEach(() => {
            setUp();
            owners = 0;
        });

        async function owner(): Promise<{
            readonly browser: TestBrowser;
            readonly email: string;
            readonly orgId: string;
        }> {
            owners++;
            const browser = harness.browser({ ip: `203.0.113.${String(owners)}` });
            const { email } = await signUp(harness, browser);
            expect((await browser.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(200);
            const session = (await browser.request('GET', '/api/session')).body as SessionView;
            return { browser, email, orgId: session.activeOrg.id };
        }

        async function registered(browser: TestBrowser): Promise<TestEngine> {
            const view = (await browser.request('POST', '/api/engines/link-codes')).body as LinkCodeView;
            const engine = await createTestEngine();
            const request = await engine.register(LinkCode.parse(view.linkCode));
            expect((await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request)).status).toBe(
                200,
            );
            return engine;
        }

        async function beat(engine: TestEngine, seq: number): Promise<TestResponse> {
            const heartbeat = await signedHeartbeat(engine, seq, harness.clock.nowMs());
            return harness.post(heartbeatPath(engine.engineId), heartbeat.body, heartbeat.headers);
        }

        async function list(browser: TestBrowser): Promise<readonly EngineView[]> {
            const response = await browser.request('GET', ENGINES);
            expect(response.status).toBe(200);
            return (response.body as { engines: EngineView[] }).engines;
        }

        async function detail(browser: TestBrowser, engineId: string): Promise<TestResponse> {
            return browser.request('GET', `${ENGINES}/${engineId}`);
        }

        function revoke(browser: TestBrowser, engineId: string): Promise<TestResponse> {
            return browser.request('POST', `${ENGINES}/${engineId}/revoke`);
        }

        async function stepUp(browser: TestBrowser): Promise<void> {
            const options = requestOptions(await browser.request('POST', '/api/auth/step-up/options'));
            const response = await browser.authenticator.assert(options);
            expect((await browser.request('POST', '/api/auth/step-up/verify', { response })).status).toBe(200);
        }

        function expectProblem(response: TestResponse, status: number, code: string): void {
            expect([response.status, problemCode(response)]).toEqual([status, code]);
        }

        describe('list and detail', () => {
            it('needs a session', async () => {
                const stranger = harness.browser();
                const { browser } = await owner();
                const engine = await registered(browser);
                expectProblem(await stranger.request('GET', ENGINES), 401, 'unauthorized');
                expectProblem(await detail(stranger, engine.engineId), 401, 'unauthorized');
                expectProblem(await revoke(stranger, engine.engineId), 401, 'unauthorized');
            });

            it('shows a user of org A only org A’s engines, oldest first', async () => {
                const a = await owner();
                const b = await owner();
                const first = await registered(a.browser);
                harness.clock.advance(1000);
                const second = await registered(a.browser);
                const foreign = await registered(b.browser);
                const engines = await list(a.browser);
                expect(engines.map((engine) => engine.engineId)).toEqual([first.engineId, second.engineId]);
                expect(engines[0]).toEqual({
                    engineId: first.engineId,
                    label: null,
                    hostname: `${first.engineId}.${TEST_ENGINE_DOMAIN}`,
                    customHostnames: [],
                    mode: 'tunnel',
                    registeredVersion: '1.0.0',
                    status: 'never-seen',
                    suspendedBy: null,
                    createdAt: harness.clock.nowMs() - 1000,
                    lastSeenAt: null,
                    heartbeat: null,
                    reachableRelays: null,
                });
                expect((await list(b.browser)).map((engine) => engine.engineId)).toEqual([foreign.engineId]);
                expect(JSON.stringify(await list(b.browser))).not.toContain(a.orgId);
            });

            it('answers org B’s engine ID with the same 404 as an unknown one', async () => {
                const a = await owner();
                const b = await owner();
                const own = await registered(a.browser);
                const foreign = await registered(b.browser);
                const mine = await detail(a.browser, own.engineId);
                expect(mine.status).toBe(200);
                expect((mine.body as { engine: EngineView }).engine.engineId).toBe(own.engineId);
                const theirs = await detail(a.browser, foreign.engineId);
                const unknown = await detail(a.browser, (await createTestEngine()).engineId);
                expectProblem(theirs, 404, 'not-found');
                expect(theirs.body).toEqual(unknown.body);
                expectProblem(await detail(a.browser, 'NOT-AN-ENGINE-ID'), 400, 'invalid-request');
            });

            it('shows live status and the last heartbeat as received', async () => {
                const { browser } = await owner();
                const engine = await registered(browser);
                expect((await beat(engine, 7)).status).toBe(204);
                const receivedAt = harness.clock.nowMs();
                const online = (await detail(browser, engine.engineId)).body as { engine: EngineView };
                expect(online.engine).toMatchObject({
                    status: 'online',
                    lastSeenAt: receivedAt,
                    heartbeat: {
                        seq: 7,
                        ts: new Date(receivedAt).toISOString(),
                        receivedAt,
                        version: '1.4.2',
                        uptimeS: 3600,
                        diskPct: 40,
                        ramPct: 70,
                        cpuLoad: 'low',
                        update: 'none',
                        agents: 3,
                        members: 2,
                    },
                });
                harness.clock.advance(10 * MINUTE_MS);
                expect(await harness.engineStatuses.runAlarm(engine.engineId)).toBe(true);
                expect((await list(browser))[0]).toMatchObject({ status: 'offline', lastSeenAt: receivedAt });
            });

            it('lists the engine’s active custom hostnames', async () => {
                const { browser } = await owner();
                const engine = await registered(browser);
                const claim: HostnameClaim = {
                    hostname: Hostname.parse('agents.customer.test'),
                    sig: ed25519SignatureFromBytes(new Uint8Array(64)),
                };
                harness.engineHostnames.set(engine.engineId, [claim]);
                expect((await list(browser))[0]?.customHostnames).toEqual(['agents.customer.test']);
            });

            it('shows unknown for an engine whose status object times out, and the rest normally', async () => {
                const stalled = new Set<EngineId>();
                const asked: EngineId[] = [];
                setUp({ wrapEngineStatus: stalling(stalled, asked) });
                const { browser } = await owner();
                const slow = await registered(browser);
                harness.clock.advance(1000);
                const fast = await registered(browser);
                expect((await beat(fast, 1)).status).toBe(204);
                stalled.add(slow.engineId);
                const answer = browser.request('GET', ENGINES);
                await expect.poll(() => asked.includes(slow.engineId) && harness.timer.pending() === 1).toBe(true);
                harness.timer.elapse();
                const response = await answer;
                expect(response.status).toBe(200);
                const engines = (response.body as { engines: EngineView[] }).engines;
                expect(engines.map((engine) => [engine.engineId, engine.status])).toEqual([
                    [slow.engineId, 'unknown'],
                    [fast.engineId, 'online'],
                ]);
                expect(engines[0]).toMatchObject({ lastSeenAt: null, heartbeat: null });
                expect(harness.logger.entries).toContainEqual({
                    level: 'warn',
                    event: 'engines.status-timeout',
                    fields: { engineId: slow.engineId },
                });
            });

            it('never asks the status object of an engine the actor may not read', async () => {
                const asked: EngineId[] = [];
                setUp({ wrapEngineStatus: stalling(new Set(), asked) });
                const a = await owner();
                const b = await owner();
                const foreign = await registered(b.browser);
                await list(a.browser);
                expectProblem(await detail(a.browser, foreign.engineId), 404, 'not-found');
                await stepUp(a.browser);
                expectProblem(await revoke(a.browser, foreign.engineId), 404, 'not-found');
                expect(asked).not.toContain(foreign.engineId);
            });
        });

        describe('revoke', () => {
            it('needs a fresh step-up and changes nothing without one', async () => {
                const { browser, orgId } = await owner();
                const engine = await registered(browser);
                expectProblem(await revoke(browser, engine.engineId), 403, 'step-up-required');
                await stepUp(browser);
                harness.clock.advance(STEP_UP_WINDOW_MS + 1);
                expectProblem(await revoke(browser, engine.engineId), 403, 'step-up-required');
                expect((await list(browser))[0]).toMatchObject({ status: 'never-seen', suspendedBy: null });
                expect(await fixture.orgAudit(orgId)).toEqual([]);
            });

            it('is denied with recovery-cooldown for 72 hours after an account recovery', async () => {
                const { browser, email } = await owner();
                const engine = await registered(browser);
                const recovered = harness.browser({ ip: '203.0.113.200' });
                const token = await requestRecovery(harness, recovered, email);
                const { verify } = await registerWith(
                    recovered,
                    '/api/auth/recovery/options',
                    '/api/auth/recovery/verify',
                    { token },
                );
                expect(verify.status).toBe(200);
                await stepUp(recovered);
                expectProblem(await revoke(recovered, engine.engineId), 403, 'recovery-cooldown');
                expect((await list(recovered))[0]?.status).toBe('never-seen');
                harness.clock.advance(RECOVERY_COOLDOWN_MS);
                await stepUp(recovered);
                expect((await revoke(recovered, engine.engineId)).status).toBe(200);
            });

            it('is forbidden to a role without engine.revoke', async () => {
                setUp({
                    policy: {
                        ...DASHBOARD_POLICY,
                        'engine.revoke': { ...DASHBOARD_POLICY['engine.revoke'], orgRoles: [] },
                    },
                });
                const { browser, orgId } = await owner();
                const engine = await registered(browser);
                await stepUp(browser);
                expectProblem(await revoke(browser, engine.engineId), 403, 'forbidden');
                expect(await fixture.orgAudit(orgId)).toEqual([]);
            });

            it('answers org B’s engine ID with 404 and leaves it alone', async () => {
                const a = await owner();
                const b = await owner();
                const foreign = await registered(b.browser);
                await stepUp(a.browser);
                expectProblem(await revoke(a.browser, foreign.engineId), 404, 'not-found');
                expect((await list(b.browser))[0]?.status).toBe('never-seen');
                expect(await fixture.orgAudit(a.orgId)).toEqual([]);
                expect(await fixture.orgAudit(b.orgId)).toEqual([]);
            });

            it('suspends the engine for good with one audit entry; heartbeats and re-registration are refused', async () => {
                const { browser, orgId } = await owner();
                const engine = await registered(browser);
                expect((await beat(engine, 1)).status).toBe(204);
                await stepUp(browser);
                const response = await revoke(browser, engine.engineId);
                expect(response.status).toBe(200);
                expect((response.body as { engine: EngineView }).engine).toMatchObject({
                    engineId: engine.engineId,
                    status: 'suspended',
                    suspendedBy: 'owner',
                });
                const session = (await browser.request('GET', '/api/session')).body as SessionView;
                expect(await fixture.orgAudit(orgId)).toEqual([
                    {
                        orgId,
                        actorUserId: session.user.id,
                        action: 'engine.revoke',
                        targetType: 'engine',
                        targetId: engine.engineId,
                    },
                ]);
                expect(await harness.deps.engines.findInOrg(orgIdSchema.parse(orgId), engine.engineId)).toMatchObject({
                    status: 'suspended',
                    statusReason: 'owner-revoked',
                });
                expect((await harness.deps.registry.findEngine(engine.engineId))?.status).toBe('suspended');
                expect((await list(browser))[0]).toMatchObject({ status: 'suspended', suspendedBy: 'owner' });
                expectProblem(await beat(engine, 2), 403, 'engine-suspended');
                const view = (await browser.request('POST', '/api/engines/link-codes')).body as LinkCodeView;
                const again = await harness
                    .browser({ ip: '198.51.100.7' })
                    .request('POST', REGISTER_PATH, await engine.register(LinkCode.parse(view.linkCode)));
                expectProblem(again, 403, 'engine-suspended');

                const repeated = await revoke(browser, engine.engineId);
                expect(repeated.status).toBe(200);
                expect(await fixture.orgAudit(orgId)).toHaveLength(1);
            });
        });

        describe('rename', () => {
            function rename(browser: TestBrowser, engineId: string, body: unknown): Promise<TestResponse> {
                return browser.request('POST', `${ENGINES}/${engineId}/label`, body);
            }

            it('labels the engine with one audit entry per change, without a step-up, and clears it with null', async () => {
                const { browser, orgId } = await owner();
                const engine = await registered(browser);
                expect((await list(browser))[0]?.label).toBeNull();
                const response = await rename(browser, engine.engineId, { label: 'Produkce – Brno' });
                expect(response.status).toBe(200);
                expect((response.body as { engine: EngineView }).engine).toMatchObject({
                    engineId: engine.engineId,
                    label: 'Produkce – Brno',
                });
                expect((await list(browser))[0]?.label).toBe('Produkce – Brno');
                expect((await rename(browser, engine.engineId, { label: 'Produkce – Brno' })).status).toBe(200);
                const session = (await browser.request('GET', '/api/session')).body as SessionView;
                expect(await fixture.orgAudit(orgId)).toEqual([
                    {
                        orgId,
                        actorUserId: session.user.id,
                        action: 'engine.rename',
                        targetType: 'engine',
                        targetId: engine.engineId,
                    },
                ]);
                expect((await rename(browser, engine.engineId, { label: null })).status).toBe(200);
                expect((await list(browser))[0]?.label).toBeNull();
                expect(await fixture.orgAudit(orgId)).toHaveLength(2);
            });

            it.each([
                ['a missing label', {}],
                ['an empty label', { label: '' }],
                ['a label with spaces at the ends', { label: ' Prod ' }],
                ['a label too long', { label: 'a'.repeat(41) }],
                ['markup', { label: '<b>Prod</b>' }],
                ['a URL', { label: 'https://evil.example' }],
                ['an unknown field', { label: 'Prod', hostname: 'evil.example' }],
                ['a number', { label: 42 }],
            ])('refuses %s with 400 and changes nothing', async (_, body) => {
                const { browser, orgId } = await owner();
                const engine = await registered(browser);
                expectProblem(await rename(browser, engine.engineId, body), 400, 'invalid-request');
                expect((await list(browser))[0]?.label).toBeNull();
                expect(await fixture.orgAudit(orgId)).toEqual([]);
            });

            it('answers org B’s engine ID with 404 and leaves it alone', async () => {
                const a = await owner();
                const b = await owner();
                const foreign = await registered(b.browser);
                expectProblem(await rename(a.browser, foreign.engineId, { label: 'Mine' }), 404, 'not-found');
                expect((await list(b.browser))[0]?.label).toBeNull();
                expect(await fixture.orgAudit(a.orgId)).toEqual([]);
                expect(await fixture.orgAudit(b.orgId)).toEqual([]);
            });

            it('is forbidden to a role without engine.rename', async () => {
                setUp({
                    policy: {
                        ...DASHBOARD_POLICY,
                        'engine.rename': { ...DASHBOARD_POLICY['engine.rename'], orgRoles: [] },
                    },
                });
                const { browser, orgId } = await owner();
                const engine = await registered(browser);
                expectProblem(await rename(browser, engine.engineId, { label: 'Prod' }), 403, 'forbidden');
                expect(await fixture.orgAudit(orgId)).toEqual([]);
            });

            it('needs a session', async () => {
                const { browser } = await owner();
                const engine = await registered(browser);
                const anonymous = harness.browser({ ip: '203.0.113.250' });
                expect((await rename(anonymous, engine.engineId, { label: 'Prod' })).status).toBe(401);
            });
        });

        describe('active organization', () => {
            it('switches only to an organization the user is a member of', async () => {
                const a = await owner();
                const b = await owner();
                const switched = await a.browser.request('POST', '/api/session/active-org', { orgId: a.orgId });
                expect(switched.status).toBe(200);
                expect((switched.body as SessionView).activeOrg.id).toBe(a.orgId);
                const foreign = await a.browser.request('POST', '/api/session/active-org', { orgId: b.orgId });
                expectProblem(foreign, 404, 'not-found');
                expect(((await a.browser.request('GET', '/api/session')).body as SessionView).activeOrg.id).toBe(
                    a.orgId,
                );
                expectProblem(
                    await a.browser.request('POST', '/api/session/active-org', { orgId: 'nope' }),
                    400,
                    'invalid-request',
                );
                expectProblem(
                    await harness.browser().request('POST', '/api/session/active-org', { orgId: a.orgId }),
                    401,
                    'unauthorized',
                );
            });
        });
    });
}
