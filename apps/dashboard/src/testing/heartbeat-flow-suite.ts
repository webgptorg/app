import {
    HEARTBEAT_MAX_BODY_BYTES,
    heartbeatPath,
    LinkCode,
    ProblemDetails,
    REGISTER_PATH,
    type EngineId,
} from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cookieName } from '../paraglide/runtime';
import { PAYLOAD_RETENTION_MS, type HeartbeatTiming } from '../domain/status/engine-status';
import type { LinkCodeView } from '../shared/api/routes';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import { requestOptions, signUp, uniqueEmail } from './auth-flows';
import { createTestEngine, type TestEngine } from './test-engine';
import { heartbeatJson, signedHeartbeat, signedJson, type SignedHeartbeat } from './test-heartbeat';

/** Not the defaults, so the suite shows the configuration is what counts: offline after 3 × 15 s + 15 s. */
export const FLOW_HEARTBEAT: HeartbeatTiming = { intervalS: 15, missedLimit: 3, graceS: 15, perEngineLimit: 4 };
const OFFLINE_AFTER_MS = 60_000;

export interface HeartbeatFlowFixture {
    /** Built with `heartbeat: FLOW_HEARTBEAT` and the alert recipients of the stores under test. */
    readonly harness: AuthHarness;
    /** What D-06's revocation and I-05's suspension will do to the engine's row. */
    suspend(engineId: EngineId): Promise<void>;
}

/**
 * D-05's acceptance tests over HTTP: engines post C-03 heartbeats as M-06 does, and their status objects run in
 * process with the alarms fired by hand. Runs on the in-memory stores (unit project) and on D1 (workers project); the
 * Durable Object itself is covered by `engine-status.workers.test.ts`.
 */
export function describeHeartbeatFlows(name: string, makeFixture: () => HeartbeatFlowFixture): void {
    describe(name, () => {
        let fixture: HeartbeatFlowFixture;
        let harness: AuthHarness;
        let owners = 0;

        beforeEach(() => {
            fixture = makeFixture();
            harness = fixture.harness;
            owners = 0;
        });

        async function owner(locale: 'en' | 'cs' = 'en'): Promise<{ browser: TestBrowser; email: string }> {
            owners++;
            const browser = harness.browser({ ip: `203.0.113.${String(owners)}` });
            browser.cookies.set(cookieName, locale);
            const { email } = await signUp(harness, browser, uniqueEmail('owner'));
            expect((await browser.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(200);
            return { browser, email };
        }

        async function registered(browser?: TestBrowser): Promise<TestEngine> {
            const issuer = browser ?? (await owner()).browser;
            const view = (await issuer.request('POST', '/api/engines/link-codes')).body as LinkCodeView;
            const engine = await createTestEngine();
            const request = await engine.register(LinkCode.parse(view.linkCode));
            expect((await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request)).status).toBe(
                200,
            );
            return engine;
        }

        function send(
            engineId: EngineId,
            heartbeat: Pick<SignedHeartbeat, 'body'> & { readonly headers?: Readonly<Record<string, string>> },
        ): Promise<TestResponse> {
            return harness.post(heartbeatPath(engineId), heartbeat.body, heartbeat.headers ?? {});
        }

        function beat(engine: TestEngine, seq: number, atMs = harness.clock.nowMs()): Promise<SignedHeartbeat> {
            return signedHeartbeat(engine, seq, atMs);
        }

        async function revoke(browser: TestBrowser, engineId: EngineId): Promise<void> {
            const options = requestOptions(await browser.request('POST', '/api/auth/step-up/options'));
            const response = await browser.authenticator.assert(options);
            expect((await browser.request('POST', '/api/auth/step-up/verify', { response })).status).toBe(200);
            expect((await browser.request('POST', `/api/engines/${engineId}/revoke`)).status).toBe(200);
        }

        function expectProblem(response: TestResponse, status: number, code: string): void {
            expect(response.status).toBe(status);
            expect(response.headers.get('Content-Type')).toBe('application/problem+json');
            // C-03's strict schema: no member it does not declare.
            expect(ProblemDetails.parse(response.body)).toMatchObject({ status, code });
        }

        it('accepts a signed heartbeat with 204, and the engine’s status shows it', async () => {
            const engine = await registered();
            const response = await send(engine.engineId, await beat(engine, 1));
            expect(response.status).toBe(204);
            expect(response.body).toBeNull();
            expect(await harness.engineStatuses.getStatus(engine.engineId)).toMatchObject({
                state: 'online',
                lastSeenAt: harness.clock.nowMs(),
                lastSeq: 1,
                payload: { version: '1.4.2', diskPct: 40, ramPct: 70, agents: 3, members: 2 },
            });
        });

        it('counts registrations and heartbeats by outcome, and requests by route template only (I-04)', async () => {
            const engine = await registered();
            expect((await send(engine.engineId, await beat(engine, 1))).status).toBe(204);
            expect((await send(engine.engineId, await beat(engine, 1))).status).toBe(409);
            const metrics = harness.metrics.records.map((record) => record.metric);
            expect(metrics).toContainEqual({ name: 'ptbk_dashboard_registrations_total', outcome: 'registered' });
            expect(metrics).toContainEqual({ name: 'ptbk_dashboard_heartbeats_total', outcome: 'accepted' });
            expect(metrics).toContainEqual({ name: 'ptbk_dashboard_heartbeats_total', outcome: 'replayed-seq' });
            expect(metrics).toContainEqual({
                name: 'ptbk_dashboard_requests_total',
                route: '/v1/engines/:engineId/heartbeat',
                method: 'POST',
                status: 409,
            });
            expect(JSON.stringify(metrics)).not.toContain(engine.engineId);
        });

        it('keeps only the numbers: no signature, address or header reaches the stored status', async () => {
            const engine = await registered();
            const heartbeat = await beat(engine, 1);
            expect((await send(engine.engineId, heartbeat)).status).toBe(204);
            const stored = JSON.stringify(harness.engineStatuses.storage(engine.engineId).stored());
            expect(stored).not.toContain(heartbeat.signature.slice('ed25519='.length));
            expect(stored).not.toContain('198.51.100');
            expect(stored).not.toContain(engine.publicKey);
        });

        it('refuses a missing header and a header of another scheme as bad-signature-header', async () => {
            const engine = await registered();
            const { body, signature } = await beat(engine, 1);
            expectProblem(await send(engine.engineId, { body }), 401, 'bad-signature-header');
            const rsa = signature.replace('ed25519=', 'rsa=');
            expectProblem(
                await send(engine.engineId, { body, headers: { 'Ptbk-Signature': rsa } }),
                401,
                'bad-signature-header',
            );
            expectProblem(
                await send(engine.engineId, { body, headers: { 'Ptbk-Signature': `${signature}${'A'.repeat(300)}` } }),
                401,
                'bad-signature-header',
            );
        });

        it('refuses a signature by another key and a body altered after signing as bad-signature', async () => {
            const engine = await registered();
            const other = await createTestEngine();
            const byOther = await signedJson(engine, heartbeatJson(engine, 1, harness.clock.nowMs()), other.signer);
            expectProblem(await send(engine.engineId, byOther), 401, 'bad-signature');
            const signed = await beat(engine, 2);
            const altered = new TextEncoder().encode(
                new TextDecoder().decode(signed.body).replace('"agents":3', '"agents":4'),
            );
            expectProblem(await send(engine.engineId, { ...signed, body: altered }), 401, 'bad-signature');
            expect(await harness.engineStatuses.getStatus(engine.engineId)).toEqual({ state: 'never-seen' });
        });

        it('refuses a replayed body with 409', async () => {
            const engine = await registered();
            const heartbeat = await beat(engine, 1);
            expect((await send(engine.engineId, heartbeat)).status).toBe(204);
            harness.clock.advance(1000);
            expectProblem(await send(engine.engineId, heartbeat), 409, 'replayed-seq');
        });

        it('refuses a timestamp 3 minutes old or ahead with stale-timestamp and the server’s time', async () => {
            const engine = await registered();
            const now = harness.clock.nowMs();
            for (const [seq, skew] of [
                [1, -180_000],
                [2, 180_000],
            ] as const) {
                const response = await send(engine.engineId, await beat(engine, seq, now + skew));
                expectProblem(response, 401, 'stale-timestamp');
                expect((response.body as { serverTime: string }).serverTime).toBe(new Date(now).toISOString());
            }
        });

        it('refuses a body for another engine and a body with an unknown field with 400', async () => {
            const engine = await registered();
            const other = await createTestEngine();
            const valid = heartbeatJson(engine, 1, harness.clock.nowMs());
            expectProblem(
                await send(engine.engineId, await signedJson(engine, { ...valid, engineId: other.engineId })),
                400,
                'engine-mismatch',
            );
            expectProblem(
                await send(engine.engineId, await signedJson(engine, { ...valid, hostname: 'leak.example' })),
                400,
                'invalid-body',
            );
        });

        it('answers 404 for an unknown engine and 403 for a suspended one, without touching their status', async () => {
            const unknown = await createTestEngine();
            expectProblem(await send(unknown.engineId, await beat(unknown, 1)), 404, 'not-found');
            const engine = await registered();
            await fixture.suspend(engine.engineId);
            expectProblem(await send(engine.engineId, await beat(engine, 1)), 403, 'engine-suspended');
            expect(await harness.engineStatuses.getStatus(engine.engineId)).toEqual({ state: 'never-seen' });
            expect(await harness.engineStatuses.getStatus(unknown.engineId)).toEqual({ state: 'never-seen' });
        });

        it('refuses a body over 4 KiB with 413 and a malformed engine ID with 400', async () => {
            const engine = await registered();
            const { headers } = await beat(engine, 1);
            const tooLarge = new Uint8Array(HEARTBEAT_MAX_BODY_BYTES + 1).fill(0x20);
            expectProblem(await send(engine.engineId, { body: tooLarge, headers }), 413, 'too-large');
            const response = await harness.post(
                '/v1/engines/NOT-AN-ID/heartbeat',
                (await beat(engine, 2)).body,
                headers,
            );
            expectProblem(response, 400, 'invalid-request');
        });

        it('limits each engine to the configured heartbeats per minute, whatever their outcome', async () => {
            const engine = await registered();
            const calm = await registered();
            for (let seq = 1; seq <= FLOW_HEARTBEAT.perEngineLimit; seq++) {
                expect((await send(engine.engineId, await beat(engine, seq))).status).toBe(204);
            }
            const limited = await send(engine.engineId, await beat(engine, 99));
            expectProblem(limited, 429, 'rate-limited');
            expect(await harness.engineStatuses.getStatus(engine.engineId)).toMatchObject({ lastSeq: 4 });
            expect((await send(calm.engineId, await beat(calm, 1))).status).toBe(204);
            harness.clock.advance(60_000);
            expect((await send(engine.engineId, await beat(engine, 100))).status).toBe(204);
        });

        it('emails one engine-offline alert to the owner, in their locale, after 3 missed heartbeats', async () => {
            const czech = await owner('cs');
            const bystander = await owner('en');
            const engine = await registered(czech.browser);
            await registered(bystander.browser);
            const lastSeenAt = harness.clock.nowMs();
            expect((await send(engine.engineId, await beat(engine, 1))).status).toBe(204);

            harness.clock.set(lastSeenAt + OFFLINE_AFTER_MS - 1);
            expect(await harness.engineStatuses.runAlarm(engine.engineId)).toBe(true);
            expect(harness.outbox.sent.filter((message) => message.template === 'engine-offline')).toEqual([]);

            harness.clock.set(lastSeenAt + OFFLINE_AFTER_MS);
            expect(await harness.engineStatuses.runAlarm(engine.engineId)).toBe(true);
            const alerts = harness.outbox.sent.filter((message) => message.template === 'engine-offline');
            expect(alerts).toEqual([
                {
                    template: 'engine-offline',
                    to: czech.email,
                    locale: 'cs',
                    engineId: engine.engineId,
                    hostname: `${engine.engineId}.engines.ptbk.test`,
                    lastSeenAt,
                    link: `https://app.ptbk.test/engines/${engine.engineId}`,
                },
            ]);
            expect(await harness.engineStatuses.getStatus(engine.engineId)).toMatchObject({ state: 'offline' });

            harness.clock.advance(60 * 60_000);
            await harness.engineStatuses.runAlarm(engine.engineId);
            expect(harness.outbox.sentTo(czech.email).filter((m) => m.template === 'engine-offline')).toHaveLength(1);
            expect(harness.outbox.sentTo(bystander.email).filter((m) => m.template === 'engine-offline')).toEqual([]);
        });

        it('emails nothing about an engine its owner revoked, and keeps refusing its heartbeats', async () => {
            const { browser } = await owner();
            const engine = await registered(browser);
            const fresh = await registered(browser);
            const lastSeenAt = harness.clock.nowMs();
            expect((await send(engine.engineId, await beat(engine, 1))).status).toBe(204);
            // A first heartbeat counting no member owes the online notice at once.
            const unclaimed = await signedHeartbeat(fresh, 1, lastSeenAt, { members: 0 });
            expect((await send(fresh.engineId, unclaimed)).status).toBe(204);

            await revoke(browser, engine.engineId);
            await revoke(browser, fresh.engineId);
            expectProblem(await send(engine.engineId, await beat(engine, 2)), 403, 'engine-suspended');

            expect(await harness.engineStatuses.runAlarm(fresh.engineId)).toBe(true);
            harness.clock.set(lastSeenAt + OFFLINE_AFTER_MS);
            for (const { engineId } of [engine, fresh]) {
                expect(await harness.engineStatuses.runAlarm(engineId)).toBe(true);
            }
            harness.clock.set(lastSeenAt + PAYLOAD_RETENTION_MS);
            for (const { engineId } of [engine, fresh]) {
                expect(await harness.engineStatuses.runAlarm(engineId)).toBe(true);
                expect(await harness.engineStatuses.getStatus(engineId)).toMatchObject({
                    state: 'offline',
                    lastSeq: null,
                });
                expect(await harness.engineStatuses.runAlarm(engineId)).toBe(false);
            }
            expect(harness.outbox.sent.filter((message) => message.template.startsWith('engine-'))).toEqual([]);
        });
    });
}
