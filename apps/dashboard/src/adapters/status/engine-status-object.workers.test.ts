import { HEARTBEAT_MAX_BODY_BYTES, heartbeatPath, ProblemDetails, type EngineId } from '@ptbk/protocol';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testAccount } from '../../testing/auth-store-contract';
import { createTestEngine, type TestEngine } from '../../testing/test-engine';
import { heartbeatJson, signedHeartbeat, signedJson, type SignedHeartbeat } from '../../testing/test-heartbeat';
import { createDatabase } from '../db/client';
import { createD1AuthStore } from '../db/d1-auth-store';

const ORIGIN = 'https://app.ptbk.test';
// Ahead of real time, so no alarm this suite sets fires on its own: only `runDurableObjectAlarm` runs them.
const NOW = 1_900_000_000_000;
// wrangler.jsonc's dev HEARTBEAT: 3 × 60 s + 15 s, 5 per engine and minute.
const OFFLINE_AFTER_MS = 195_000;
const PER_ENGINE_LIMIT = 5;

let ips = 0;

function stub(engineId: EngineId) {
    return env.ENGINE_STATUS.get(env.ENGINE_STATUS.idFromName(engineId));
}

/** The built Worker, as an engine reaches it; each call comes from its own address, so only per-engine limits bite. */
function post(engineId: EngineId | string, heartbeat: Pick<SignedHeartbeat, 'body'> & { headers?: object }) {
    ips++;
    return exports.default.fetch(
        new Request(`${ORIGIN}${heartbeatPath(engineId as EngineId)}`, {
            method: 'POST',
            headers: { 'CF-Connecting-IP': `198.18.${String(ips >> 8)}.${String(ips & 255)}`, ...heartbeat.headers },
            body: heartbeat.body,
        }),
    );
}

async function expectProblem(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    const problem = ProblemDetails.parse(await response.json());
    expect(problem).toMatchObject({ status, code });
    return problem;
}

async function emailsTo(address: string): Promise<{ template: string; locale: string; text: string }[]> {
    const response = await exports.default.fetch(
        new Request(`${ORIGIN}/api/__dev/emails?to=${encodeURIComponent(address)}`, {
            headers: { 'CF-Connecting-IP': '198.19.0.1' },
        }),
    );
    return (await response.json<{ emails: { template: string; locale: string; text: string }[] }>()).emails;
}

/** An organization with a verified Czech owner, an unverified owner, and an engine registered to it, in D1. */
async function registeredEngine(status: 'active' | 'suspended' = 'active') {
    const accounts = createD1AuthStore(createDatabase(env.DB)).accounts;
    const owner = testAccount();
    await accounts.createAccount(owner);
    const unverified = testAccount();
    await env.DB.prepare(
        'INSERT INTO users (id, email, email_verified_at, locale, created_at, webauthn_user_id) VALUES (?, ?, NULL, ?, ?, ?)',
    )
        .bind(unverified.userId, unverified.user.email, 'en', NOW, crypto.getRandomValues(new Uint8Array(32)))
        .run();
    await env.DB.prepare('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .bind(owner.orgId, unverified.userId, 'owner', NOW)
        .run();
    const engine = await createTestEngine();
    await env.DB.prepare(
        'INSERT INTO engines (engine_id, org_id, public_key, hostname, mode, engine_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
        .bind(
            engine.engineId,
            owner.orgId,
            engine.publicKey,
            `${engine.engineId}.engines.ptbk.test`,
            'tunnel',
            '1.0.0',
            status,
            NOW,
            NOW,
        )
        .run();
    return { engine, owner: owner.user.email, unverified: unverified.user.email };
}

describe('EngineStatus Durable Object behind POST /v1/engines/:engineId/heartbeat', () => {
    let engine: TestEngine;

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        ({ engine } = await registeredEngine());
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('accepts a valid heartbeat with 204, and getStatus() and the storage show its numbers only', async () => {
        const heartbeat = await signedHeartbeat(engine, 1, NOW);
        const response = await post(engine.engineId, heartbeat);
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
        expect(await stub(engine.engineId).getStatus()).toMatchObject({
            state: 'online',
            lastSeenAt: NOW,
            lastSeq: 1,
            payload: { ts: new Date(NOW).toISOString(), receivedAt: NOW, cpuLoad: 'low', agents: 3 },
        });
        await runInDurableObject(stub(engine.engineId), async (_, state) => {
            expect(await state.storage.getAlarm()).toBe(NOW + OFFLINE_AFTER_MS);
            expect([...(await state.storage.list()).keys()]).toEqual(['status']);
            const stored = JSON.stringify(await state.storage.get('status'));
            expect(stored).not.toContain(heartbeat.signature.slice('ed25519='.length));
            expect(stored).not.toContain('198.18.');
        });
    });

    it('refuses a missing header and the wrong scheme with 401 bad-signature-header', async () => {
        const { body, signature } = await signedHeartbeat(engine, 1, NOW);
        await expectProblem(await post(engine.engineId, { body }), 401, 'bad-signature-header');
        const rsa = { 'Ptbk-Signature': signature.replace('ed25519=', 'rsa=') };
        await expectProblem(await post(engine.engineId, { body, headers: rsa }), 401, 'bad-signature-header');
    });

    it('refuses a signature by another key and a body altered after signing with 401 bad-signature', async () => {
        const other = await createTestEngine();
        const byOther = await signedJson(engine, heartbeatJson(engine, 1, NOW), other.signer);
        await expectProblem(await post(engine.engineId, byOther), 401, 'bad-signature');
        const signed = await signedHeartbeat(engine, 2, NOW);
        const altered = new TextEncoder().encode(new TextDecoder().decode(signed.body).replace('"seq":2', '"seq":3'));
        await expectProblem(await post(engine.engineId, { ...signed, body: altered }), 401, 'bad-signature');
    });

    it('refuses a replayed body with 409', async () => {
        const heartbeat = await signedHeartbeat(engine, 1, NOW);
        expect((await post(engine.engineId, heartbeat)).status).toBe(204);
        await expectProblem(await post(engine.engineId, heartbeat), 409, 'replayed-seq');
    });

    it.each([
        ['3 minutes old', -180_000],
        ['3 minutes ahead', 180_000],
    ])('refuses a ts %s with 401 stale-timestamp whose serverTime is the clock', async (_, skew) => {
        const problem = await expectProblem(
            await post(engine.engineId, await signedHeartbeat(engine, 1, NOW + skew)),
            401,
            'stale-timestamp',
        );
        expect(problem.serverTime).toBe(new Date(NOW).toISOString());
    });

    it('refuses a path and body engine ID mismatch and an unknown field with 400', async () => {
        const other = await createTestEngine();
        const valid = heartbeatJson(engine, 1, NOW);
        const mismatch = await signedJson(engine, { ...valid, engineId: other.engineId });
        await expectProblem(await post(engine.engineId, mismatch), 400, 'engine-mismatch');
        const unknownField = await signedJson(engine, { ...valid, note: 'hello' });
        await expectProblem(await post(engine.engineId, unknownField), 400, 'invalid-body');
    });

    it('answers 404 for an unknown engine and 403 for a suspended one, leaving their objects untouched', async () => {
        const unknown = await createTestEngine();
        await expectProblem(await post(unknown.engineId, await signedHeartbeat(unknown, 1, NOW)), 404, 'not-found');
        const suspended = (await registeredEngine('suspended')).engine;
        await expectProblem(
            await post(suspended.engineId, await signedHeartbeat(suspended, 1, NOW)),
            403,
            'engine-suspended',
        );
        for (const engineId of [unknown.engineId, suspended.engineId]) {
            await runInDurableObject(stub(engineId), async (_, state) => {
                expect((await state.storage.list()).size).toBe(0);
                expect(await state.storage.getAlarm()).toBeNull();
            });
        }
    });

    it('refuses a body of 4 KiB + 1 byte with 413', async () => {
        const { headers } = await signedHeartbeat(engine, 1, NOW);
        const body = new Uint8Array(HEARTBEAT_MAX_BODY_BYTES + 1).fill(0x20);
        await expectProblem(await post(engine.engineId, { body, headers }), 413, 'too-large');
    });

    it('answers 429 once an engine sends more than the configured limit in a minute', async () => {
        for (let seq = 1; seq <= PER_ENGINE_LIMIT; seq++) {
            expect((await post(engine.engineId, await signedHeartbeat(engine, seq, NOW))).status).toBe(204);
        }
        const limited = await post(engine.engineId, await signedHeartbeat(engine, 99, NOW));
        await expectProblem(limited, 429, 'rate-limited');
        expect(await stub(engine.engineId).getStatus()).toMatchObject({ lastSeq: PER_ENGINE_LIMIT });
    });

    it('emails one engine-offline alert to the verified owner in their locale after 3 missed heartbeats', async () => {
        const seeded = await registeredEngine();
        const bystander = await registeredEngine();
        expect((await post(seeded.engine.engineId, await signedHeartbeat(seeded.engine, 1, NOW))).status).toBe(204);
        expect((await post(bystander.engine.engineId, await signedHeartbeat(bystander.engine, 1, NOW))).status).toBe(
            204,
        );

        vi.setSystemTime(NOW + OFFLINE_AFTER_MS);
        expect(await runDurableObjectAlarm(stub(seeded.engine.engineId))).toBe(true);
        const alerts = await emailsTo(seeded.owner);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ template: 'engine-offline', locale: 'cs' });
        expect(alerts[0]?.text).toContain(seeded.engine.engineId);
        expect(await emailsTo(seeded.unverified)).toEqual([]);
        expect(await emailsTo(bystander.owner)).toEqual([]);
        expect(await stub(seeded.engine.engineId).getStatus()).toMatchObject({
            state: 'offline',
            offlineSince: NOW + OFFLINE_AFTER_MS,
        });

        // The alarm now waits for the retention purge; running it early sends nothing more.
        expect(await runDurableObjectAlarm(stub(seeded.engine.engineId))).toBe(true);
        expect(await emailsTo(seeded.owner)).toHaveLength(1);
        await runInDurableObject(stub(seeded.engine.engineId), async (_, state) => {
            expect(await state.storage.getAlarm()).toBe(NOW + 30 * 24 * 3600_000);
        });
    });

    it('emails the owner that a new engine is online from the alarm the first heartbeat sets', async () => {
        const seeded = await registeredEngine();
        const first = await signedHeartbeat(seeded.engine, 1, NOW, { members: 0 });
        expect((await post(seeded.engine.engineId, first)).status).toBe(204);
        expect(await emailsTo(seeded.owner)).toEqual([]);
        await runInDurableObject(stub(seeded.engine.engineId), async (_, state) => {
            expect(await state.storage.getAlarm()).toBe(NOW);
        });

        expect(await runDurableObjectAlarm(stub(seeded.engine.engineId))).toBe(true);
        const emails = await emailsTo(seeded.owner);
        expect(emails).toMatchObject([{ template: 'engine-online', locale: 'cs' }]);
        expect(emails[0]?.text.endsWith(`/engines/${seeded.engine.engineId}`)).toBe(true);
        expect(await emailsTo(seeded.unverified)).toEqual([]);
        await runInDurableObject(stub(seeded.engine.engineId), async (_, state) => {
            expect(await state.storage.getAlarm()).toBe(NOW + OFFLINE_AFTER_MS);
        });
    });

    it('emails the owner that an engine is back after the outage its offline email reported', async () => {
        const seeded = await registeredEngine();
        expect((await post(seeded.engine.engineId, await signedHeartbeat(seeded.engine, 1, NOW))).status).toBe(204);
        vi.setSystemTime(NOW + OFFLINE_AFTER_MS);
        await runDurableObjectAlarm(stub(seeded.engine.engineId));
        const backAt = NOW + 3600_000;
        vi.setSystemTime(backAt);
        expect((await post(seeded.engine.engineId, await signedHeartbeat(seeded.engine, 2, backAt))).status).toBe(204);
        expect(await runDurableObjectAlarm(stub(seeded.engine.engineId))).toBe(true);
        expect((await emailsTo(seeded.owner)).map((email) => email.template)).toEqual([
            'engine-offline',
            'engine-back-online',
        ]);
    });

    it('emails nothing once the engine is revoked, reading its row in D1', async () => {
        const seeded = await registeredEngine();
        expect((await post(seeded.engine.engineId, await signedHeartbeat(seeded.engine, 1, NOW))).status).toBe(204);
        await env.DB.prepare(
            "UPDATE engines SET status = 'suspended', status_reason = 'owner-revoked' WHERE engine_id = ?",
        )
            .bind(seeded.engine.engineId)
            .run();
        vi.setSystemTime(NOW + OFFLINE_AFTER_MS);
        expect(await runDurableObjectAlarm(stub(seeded.engine.engineId))).toBe(true);
        expect(await emailsTo(seeded.owner)).toEqual([]);
        await runInDurableObject(stub(seeded.engine.engineId), async (_, state) => {
            expect(await state.storage.getAlarm()).toBe(NOW + 30 * 24 * 3600_000);
        });
    });

    it('forgets the engine on reset', async () => {
        expect((await post(engine.engineId, await signedHeartbeat(engine, 1, NOW))).status).toBe(204);
        await stub(engine.engineId).reset();
        expect(await stub(engine.engineId).getStatus()).toEqual({ state: 'never-seen' });
        await runInDurableObject(stub(engine.engineId), async (_, state) => {
            expect(await state.storage.getAlarm()).toBeNull();
        });
    });

    // The first import of the whole Worker entry into workerd takes seconds on a slow runner.
    it('is exported from the Worker entry next to the default handler', { timeout: 30_000 }, async () => {
        const entry = await import('../../worker');
        expect(entry.EngineStatus.name).toBe('EngineStatus');
    });
});
