import type { EngineId, HeartbeatAck, LinkCode, OwnerSetupCommitment } from '@ptbk/protocol';
import {
    HEARTBEAT_SIGNATURE_HEADER,
    REGISTER_PATH,
    buildHeartbeat,
    buildHeartbeatV2,
    createWebCryptoSigner,
    encodeBase64Url,
    deriveEngineId,
    generateEd25519KeyPair,
    heartbeatPath,
    signHeartbeat,
    signRegistration,
} from '@ptbk/protocol';
import type { Signer } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestContext, post } from '../testing/context';
import { WaitTimeout, jsonAnswer, problemAnswer, startFakeDashboard } from './dashboard';
import type { FakeDashboard, FakeDashboardOptions } from './dashboard';

const ctx = createTestContext();

afterEach(async () => {
    await ctx.closeAll();
});

async function dashboard(options?: FakeDashboardOptions): Promise<FakeDashboard> {
    return ctx.use(await startFakeDashboard(ctx, options));
}

async function signer(): Promise<Signer> {
    return createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
}

async function register(target: FakeDashboard, key: Signer, linkCode: LinkCode) {
    const request = await signRegistration(key, { linkCode, engineVersion: '1.0.0' as never, mode: 'tunnel' });
    return post(`${target.url}${REGISTER_PATH}`, JSON.stringify(request), ctx.ca.certPem);
}

function code(body: string): unknown {
    return (JSON.parse(body) as { code?: unknown }).code;
}

async function beat(target: FakeDashboard, key: Signer, engineId: EngineId, seq: number, ts = new Date()) {
    const body = buildHeartbeat({
        engineId,
        seq,
        ts: ts.toISOString().replace(/\.\d{3}Z$/, 'Z') as never,
        version: '1.0.0' as never,
        uptimeS: 1,
        diskPct: 41,
        ramPct: 55,
        cpuLoad: 'low',
        update: 'none',
        agents: 0,
        members: 1,
    });
    return post(`${target.url}${heartbeatPath(engineId)}`, body, ctx.ca.certPem, {
        [HEARTBEAT_SIGNATURE_HEADER]: await signHeartbeat(key, body),
    });
}

async function beatV2(target: FakeDashboard, key: Signer, engineId: EngineId, seq: number, acks: HeartbeatAck[]) {
    const body = buildHeartbeatV2({
        engineId,
        seq,
        ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') as never,
        version: '1.0.0' as never,
        uptimeS: 1,
        diskPct: 41,
        ramPct: 55,
        cpuLoad: 'low',
        update: 'none',
        agents: 0,
        members: 1,
        accessRequests: 0,
        acks,
    });
    return post(`${target.url}${heartbeatPath(engineId)}`, body, ctx.ca.certPem, {
        [HEARTBEAT_SIGNATURE_HEADER]: await signHeartbeat(key, body),
    });
}

describe('the fake dashboard', () => {
    it('answers heartbeat v2 with queued revocations until a beat acks them', async () => {
        const target = await dashboard();
        const key = await signer();
        const engineId = await deriveEngineId(key.publicKey());
        await register(target, key, target.issueLinkCode());
        expect(JSON.parse((await beatV2(target, key, engineId, 1, [])).body)).toEqual({ v: 1, revocations: [] });
        const id = 'revocation-0123456789';
        target.queueRevocation(engineId, id, 'token');
        expect(JSON.parse((await beatV2(target, key, engineId, 2, [])).body)).toEqual({ v: 1, revocations: ['token'] });
        const acked = await beatV2(target, key, engineId, 3, [{ id, outcome: 'not-found' }]);
        expect(JSON.parse(acked.body)).toEqual({ v: 1, revocations: [] });
        expect((await beat(target, key, engineId, 4)).status).toBe(204);
    });

    it('registers like the dashboard: once per link code, idempotent in the organisation', async () => {
        const target = await dashboard();
        const key = await signer();
        const engineId = await deriveEngineId(key.publicKey());
        const first = await register(target, key, target.issueLinkCode());
        expect(first.status).toBe(200);
        expect(first.contentType).toBe('application/json');
        expect(JSON.parse(first.body)).toEqual({
            engineId,
            hostname: `${engineId}.engine.localhost`,
            relays: ['relay-a.conformance.invalid'],
            memberKey: encodeBase64Url(target.memberSigner.publicKey()),
            ownerSetupCommitment: null,
        });
        const commitment = 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA' as OwnerSetupCommitment;
        const linkCode = target.issueLinkCode(undefined, commitment);
        const relinked = await register(target, key, linkCode);
        expect([
            relinked.status,
            (JSON.parse(relinked.body) as { ownerSetupCommitment?: unknown }).ownerSetupCommitment,
        ]).toEqual([200, commitment]);
        const reused = await register(target, key, linkCode);
        expect([reused.status, code(reused.body), reused.contentType]).toEqual([
            401,
            'invalid-link-code',
            'application/problem+json',
        ]);
        const elsewhere = await register(target, key, target.issueLinkCode('org-other'));
        expect([elsewhere.status, code(elsewhere.body)]).toEqual([409, 'engine-exists']);
        target.suspend(engineId);
        target.suspend('a'.repeat(26) as EngineId);
        const suspended = await register(target, key, target.issueLinkCode());
        expect([suspended.status, code(suspended.body)]).toEqual([403, 'engine-suspended']);
        expect(target.registrations.map((entry) => entry.answer.status)).toEqual([200, 200, 401, 409, 403]);
        expect(target.registrations[0]).toMatchObject({ signatureValid: true, engineId, contentType: null });
    });

    it('refuses what the dashboard refuses', async () => {
        const target = await dashboard({ relays: ['relay-b.localhost' as never] });
        const key = await signer();
        const valid = await signRegistration(key, {
            linkCode: target.issueLinkCode(),
            engineVersion: '1.0.0' as never,
            mode: 'tunnel',
        });
        const url = `${target.url}${REGISTER_PATH}`;
        const forged = await post(url, JSON.stringify({ ...valid, mode: 'direct' }), ctx.ca.certPem);
        expect([forged.status, code(forged.body)]).toEqual([401, 'bad-signature']);
        expect((await post(url, 'not json', ctx.ca.certPem)).status).toBe(400);
        expect((await post(url, JSON.stringify({ ...valid, extra: 1 }), ctx.ca.certPem)).status).toBe(400);
        expect((await post(url, ' '.repeat(5000), ctx.ca.certPem)).status).toBe(413);
        expect((await post(`${target.url}/elsewhere`, '', ctx.ca.certPem)).status).toBe(404);
        const unknown = await register(target, key, 'a'.repeat(25).concat('a') as LinkCode);
        expect(code(unknown.body)).toBe('invalid-link-code');
        expect(JSON.parse((await register(target, key, target.issueLinkCode())).body)).toMatchObject({
            relays: ['relay-b.localhost'],
        });
    });

    it('verifies heartbeats over the exact bytes and answers like D-05', async () => {
        const target = await dashboard();
        const key = await signer();
        const engineId = await deriveEngineId(key.publicKey());
        expect((await beat(target, key, engineId, 1)).status).toBe(404);
        await register(target, key, target.issueLinkCode());
        expect((await beat(target, key, engineId, 5)).status).toBe(204);
        expect(code((await beat(target, key, engineId, 5)).body)).toBe('replayed-seq');
        const stale = await beat(target, key, engineId, 6, new Date(Date.now() - 600_000));
        expect([stale.status, code(stale.body)]).toEqual([401, 'stale-timestamp']);
        expect(JSON.parse(stale.body)).toHaveProperty('serverTime');
        const other = await signer();
        expect(code((await beat(target, other, engineId, 7)).body)).toBe('bad-signature');
        const unsigned = await post(`${target.url}${heartbeatPath(engineId)}`, '{}', ctx.ca.certPem);
        expect(code(unsigned.body)).toBe('bad-signature-header');
        expect((await post(`${target.url}/v1/engines/nope/heartbeat`, '{}', ctx.ca.certPem)).status).toBe(404);
        target.suspend(engineId);
        expect(code((await beat(target, key, engineId, 8)).body)).toBe('engine-suspended');
        expect(target.heartbeats.map((entry) => entry.verification?.kind ?? null)).toEqual([
            null,
            'accepted',
            'replayed-seq',
            'stale-ts',
            'bad-signature',
            'bad-signature-header',
            null,
            'accepted',
        ]);
    });

    it('maps the remaining verdicts and takes scripted answers', async () => {
        const target = await dashboard({
            onRegister: (entry) => (entry.request?.mode === 'direct' ? jsonAnswer(200, { scripted: true }) : undefined),
            onHeartbeat: (entry) => (entry.rawBody.includes('"seq":9') ? problemAnswer(503, 'unavailable') : undefined),
        });
        const key = await signer();
        const engineId = await deriveEngineId(key.publicKey());
        const direct = await signRegistration(key, {
            linkCode: target.issueLinkCode(),
            engineVersion: '1.0.0' as never,
            mode: 'direct',
        });
        const scripted = await post(`${target.url}${REGISTER_PATH}`, JSON.stringify(direct), ctx.ca.certPem);
        expect(JSON.parse(scripted.body)).toEqual({ scripted: true });
        await register(target, key, target.issueLinkCode());
        expect((await beat(target, key, engineId, 9)).status).toBe(503);
        // A scripted refusal leaves the replay window where it was.
        expect((await beat(target, key, engineId, 9)).status).toBe(503);
        const garbage = await post(`${target.url}${heartbeatPath(engineId)}`, 'x', ctx.ca.certPem, {
            [HEARTBEAT_SIGNATURE_HEADER]: await signHeartbeat(key, new TextEncoder().encode('x')),
        });
        expect(code(garbage.body)).toBe('invalid-body');
        const foreign = await deriveEngineId((await signer()).publicKey());
        const body = buildHeartbeat({
            engineId: foreign,
            seq: 10,
            ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') as never,
            version: '1.0.0' as never,
            uptimeS: 1,
            diskPct: 0,
            ramPct: 0,
            cpuLoad: 'low',
            update: 'none',
            agents: 0,
            members: 0,
        });
        const mismatch = await post(`${target.url}${heartbeatPath(engineId)}`, body, ctx.ca.certPem, {
            [HEARTBEAT_SIGNATURE_HEADER]: await signHeartbeat(key, body),
        });
        expect(code(mismatch.body)).toBe('engine-mismatch');
    });

    it('answers 500 when a script throws', async () => {
        const target = await dashboard({
            onRegister: () => {
                throw new Error('script broke');
            },
        });
        expect((await register(target, await signer(), target.issueLinkCode())).status).toBe(500);
    });

    it('waits for what a check needs, and gives up with a reason', async () => {
        const target = await dashboard();
        const waiting = target.waitFor(() => target.registrations.at(0), 5000, ctx.signal);
        await register(target, await signer(), target.issueLinkCode());
        expect((await waiting).answer.status).toBe(200);
        await expect(target.waitFor(() => undefined, 20, ctx.signal)).rejects.toThrow(WaitTimeout);
        const controller = new AbortController();
        const aborted = target.waitFor(() => undefined, 5000, controller.signal);
        controller.abort(new Error('stop'));
        await expect(aborted).rejects.toThrow('stop');
        await expect(
            target.waitFor(
                () => {
                    throw new Error('selector broke');
                },
                5000,
                ctx.signal,
            ),
        ).rejects.toThrow('selector broke');
    });
});
