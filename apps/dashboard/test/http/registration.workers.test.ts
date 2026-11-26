import {
    createCryptoRandom,
    deriveEngineId,
    ed25519PublicKeyToBytes,
    generateLinkCode,
    ProblemDetails,
    REGISTER_PATH,
    RegisterEngineResponse,
    type LinkCode,
} from '@ptbk/protocol';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { cryptoRandom } from '../../src/adapters/crypto-random';
import { DEV_MEMBER_KEY } from '../../src/app/config';
import { fromBase64Url, sha256Hex } from '../../src/domain/auth/secrets';
import { memberKeySource } from '../../src/domain/teams/member-key';
import { newOrgId, newUserId, type OrgId } from '../../src/domain/ids';
import { createTestEngine } from '../../src/testing/test-engine';

const ORIGIN = 'https://app.ptbk.test';
const TTL = 30 * 60 * 1000;

let ips = 0;

/** A fresh client address per test: the dev Worker's in-memory rate limits live as long as the isolate. */
function nextIp(): string {
    ips++;
    return `192.0.2.${String(ips)}`;
}

function post(body: string, ip: string): Promise<Response> {
    return exports.default.fetch(
        new Request(`${ORIGIN}${REGISTER_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
            body,
        }),
    );
}

/** An organization on the dev catalogue's `standard` plan, which may create engines without a quota. */
async function entitledOrg(): Promise<OrgId> {
    const orgId = newOrgId(cryptoRandom);
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare("INSERT INTO organizations (id, kind, name, created_at) VALUES (?, 'personal', NULL, ?)").bind(
            orgId,
            now,
        ),
        env.DB.prepare(
            "INSERT INTO subscriptions (org_id, stripe_subscription_id, status, price_id, quantity, current_period_end, cancel_at_period_end, updated_at) VALUES (?, ?, 'active', 'price_devstandard', 1, NULL, 0, ?)",
        ).bind(orgId, `sub_${orgId}`, now),
    ]);
    return orgId;
}

/** Stored the way `issueLinkCode` stores it: the hash only. */
async function linkCodeFor(orgId: OrgId): Promise<LinkCode> {
    const code = generateLinkCode(createCryptoRandom());
    const now = Date.now();
    await env.DB.prepare(
        'INSERT INTO link_codes (code_hash, org_id, created_by_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
        .bind(await sha256Hex(code), orgId, newUserId(cryptoRandom), now, now + TTL)
        .run();
    return code;
}

async function usedAt(code: LinkCode): Promise<number | null> {
    const row = await env.DB.prepare('SELECT used_at FROM link_codes WHERE code_hash = ?')
        .bind(await sha256Hex(code))
        .first<{ used_at: number | null }>();
    return row?.used_at ?? null;
}

async function expectProblem(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(response.headers.get('Content-Type')).toBe('application/problem+json');
    expect(ProblemDetails.parse(await response.json())).toMatchObject({ status, code });
}

describe('POST /v1/engines/register on the built Worker', () => {
    it('registers an engine and answers with the identity its key derives', async () => {
        const orgId = await entitledOrg();
        const engine = await createTestEngine();
        const response = await post(JSON.stringify(await engine.register(await linkCodeFor(orgId))), nextIp());
        expect(response.status).toBe(200);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        const body = RegisterEngineResponse.parse(await response.json());
        const engineId = await deriveEngineId(ed25519PublicKeyToBytes(engine.publicKey));
        // The dev member key from wrangler.jsonc, which the built Worker runs with.
        const memberKey = (await memberKeySource(fromBase64Url(DEV_MEMBER_KEY))())?.publicKey;
        expect(body).toEqual({
            engineId,
            hostname: `${engineId}.engines.ptbk.test`,
            relays: ['relay.ptbk.test'],
            memberKey,
        });
        const row = await env.DB.prepare('SELECT org_id, public_key FROM engines WHERE engine_id = ?')
            .bind(engineId)
            .first();
        expect(row).toEqual({ org_id: orgId, public_key: engine.publicKey });
    });

    it('refuses an unknown field and a malformed public key with 400, leaving the code unused', async () => {
        const orgId = await entitledOrg();
        const code = await linkCodeFor(orgId);
        const request = await (await createTestEngine()).register(code);
        const ip = nextIp();
        await expectProblem(await post(JSON.stringify({ ...request, extra: true }), ip), 400, 'invalid-request');
        await expectProblem(
            await post(JSON.stringify({ ...request, enginePublicKey: request.enginePublicKey.slice(0, 42) }), ip),
            400,
            'invalid-request',
        );
        expect(await usedAt(code)).toBeNull();
    });

    it('refuses a 5 KiB body with 413', async () => {
        const request = await (await createTestEngine()).register(await linkCodeFor(await entitledOrg()));
        const body = JSON.stringify({ ...request, padding: 'x'.repeat(5 * 1024) });
        await expectProblem(await post(body, nextIp()), 413, 'too-large');
    });

    it('allows 100 registration attempts per hour and IP', async () => {
        const ip = nextIp();
        for (let i = 0; i < 100; i++) {
            expect((await post('{}', ip)).status).toBe(400);
        }
        await expectProblem(await post('{}', ip), 429, 'rate-limited');
        expect((await post('{}', nextIp())).status).toBe(400);
    });

    it('lets exactly one of two concurrent registrations with one code win', async () => {
        const orgId = await entitledOrg();
        const code = await linkCodeFor(orgId);
        const engines = [await createTestEngine(), await createTestEngine()];
        const requests = await Promise.all(engines.map((engine) => engine.register(code)));
        const responses = await Promise.all(requests.map((request) => post(JSON.stringify(request), nextIp())));
        expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
        const loser = responses.find((response) => response.status === 401);
        if (loser !== undefined) {
            await expectProblem(loser, 401, 'invalid-link-code');
        }
        const rows = await env.DB.prepare('SELECT COUNT(*) AS total FROM engines WHERE org_id = ?')
            .bind(orgId)
            .first<{ total: number }>();
        expect(rows?.total).toBe(1);
    });

    it('leaves the plaintext code in no column of its row after redemption', async () => {
        const orgId = await entitledOrg();
        const code = await linkCodeFor(orgId);
        const engine = await createTestEngine();
        expect((await post(JSON.stringify(await engine.register(code)), nextIp())).status).toBe(200);
        const rows = await env.DB.prepare('SELECT * FROM link_codes WHERE org_id = ?').bind(orgId).all();
        expect(rows.results).toHaveLength(1);
        expect(rows.results[0]?.['code_hash']).toBe(await sha256Hex(code));
        for (const value of Object.values(rows.results[0] ?? {})) {
            expect(String(value)).not.toContain(code);
        }
    });
});
