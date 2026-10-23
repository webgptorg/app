import {
    defaultHostname,
    ed25519SignatureFromBytes,
    LinkCode,
    REGISTER_PATH,
    RegistryEntry,
    registryPath,
    signHostnameClaim,
    type EngineId,
    type HostnameClaim,
} from '@ptbk/protocol';
import { Hostname } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import { newRelayToken, sha256Hex } from '../domain/auth/secrets';
import { newRelayTokenId, type RelayTokenId } from '../domain/ids';
import { RATE_LIMITS } from '../domain/ports/rate-limiter';
import type { LinkCodeView } from '../shared/api/routes';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import { problemCode, signUp } from './auth-flows';
import type { StoredRelayToken } from './memory-registry-stores';
import { createTestEngine, TEST_ENGINE_DOMAIN, type TestEngine } from './test-engine';

const DAY_MS = 24 * 60 * 60 * 1000;
const RELAY = 'relay-1.ptbk.test';

export interface RegistryFlowFixture {
    readonly harness: AuthHarness;
    /** Writes the row as `scripts/mint-relay-key.ts` does. */
    addRelayToken(row: StoredRelayToken): Promise<void>;
    /** What `--revoke` does. */
    revokeRelayToken(id: RelayTokenId, at: number): Promise<void>;
    relayToken(id: RelayTokenId): Promise<StoredRelayToken | null>;
    /** What D-06's revocation and I-05's suspension do to the engine's row. */
    suspend(engineId: EngineId): Promise<void>;
}

/**
 * D-04's acceptance tests over HTTP: a relay reads `registryPath(engineId)` with its relay key. Runs on the in-memory
 * stores (unit project) and on D1 (workers project).
 */
export function describeRegistryFlows(name: string, makeFixture: () => RegistryFlowFixture): void {
    describe(name, () => {
        let fixture: RegistryFlowFixture;
        let harness: AuthHarness;
        let owners = 0;

        beforeEach(() => {
            fixture = makeFixture();
            harness = fixture.harness;
            owners = 0;
        });

        async function mint(
            relayId = RELAY,
            overrides: Partial<StoredRelayToken> = {},
        ): Promise<{ readonly token: string; readonly row: StoredRelayToken }> {
            const token = newRelayToken(cryptoRandom);
            const now = harness.clock.nowMs();
            const row: StoredRelayToken = {
                id: newRelayTokenId(cryptoRandom),
                relayId,
                tokenHash: await sha256Hex(token),
                createdAt: now,
                expiresAt: now + 365 * DAY_MS,
                lastUsedAt: null,
                revokedAt: null,
                ...overrides,
            };
            await fixture.addRelayToken(row);
            return { token, row };
        }

        async function owner(): Promise<TestBrowser> {
            owners++;
            const browser = harness.browser({ ip: `203.0.113.${String(owners)}` });
            await signUp(harness, browser);
            expect((await browser.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(200);
            return browser;
        }

        async function registered(browser?: TestBrowser): Promise<TestEngine> {
            const issuer = browser ?? (await owner());
            const view = (await issuer.request('POST', '/api/engines/link-codes')).body as LinkCodeView;
            const engine = await createTestEngine();
            const request = await engine.register(LinkCode.parse(view.linkCode));
            expect((await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request)).status).toBe(
                200,
            );
            return engine;
        }

        function read(path: string, headers: Readonly<Record<string, string>> = {}): Promise<TestResponse> {
            return harness.browser({ ip: '192.0.2.50' }).request('GET', path, undefined, headers);
        }

        function asRelay(token: string, engineId: EngineId): Promise<TestResponse> {
            return read(registryPath(engineId), { Authorization: `Bearer ${token}` });
        }

        function expectUnauthorized(response: TestResponse): void {
            expect([response.status, problemCode(response)]).toEqual([401, 'unauthorized']);
        }

        it('serves an active engine as C-03 routing data only', async () => {
            const browser = await owner();
            const engine = await registered(browser);
            const { token } = await mint();
            const response = await asRelay(token, engine.engineId);
            expect(response.status).toBe(200);
            expect(response.headers.get('Cache-Control')).toBe('no-store');
            expect(response.body).toEqual({
                enginePublicKey: engine.publicKey,
                hostnames: [defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN)],
                claims: [],
                status: 'active',
            });
            // Strict: an organization, user or billing field would fail to parse.
            expect(RegistryEntry.parse(response.body)).toEqual(response.body);
            const session = (await browser.request('GET', '/api/session')).body as {
                readonly user: { readonly email: string };
                readonly activeOrg: { readonly id: string };
            };
            expect(JSON.stringify(response.body)).not.toContain(session.activeOrg.id);
            expect(JSON.stringify(response.body)).not.toContain(session.user.email);
        });

        it('serves a suspended engine with status suspended', async () => {
            const engine = await registered();
            await fixture.suspend(engine.engineId);
            const { token } = await mint();
            const response = await asRelay(token, engine.engineId);
            expect(response.status).toBe(200);
            expect(RegistryEntry.parse(response.body).status).toBe('suspended');
        });

        it('withholds the custom hostnames of a suspended engine', async () => {
            const engine = await registered();
            const hostname = Hostname.parse('agents.customer.test');
            const sig = ed25519SignatureFromBytes(await signHostnameClaim(engine.signer, hostname, engine.engineId));
            harness.engineHostnames.set(engine.engineId, [{ hostname, sig }]);
            await fixture.suspend(engine.engineId);
            const { token } = await mint();
            expect(RegistryEntry.parse((await asRelay(token, engine.engineId)).body)).toEqual({
                enginePublicKey: engine.publicKey,
                hostnames: [defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN)],
                claims: [],
                status: 'suspended',
            });
        });

        it('serves custom hostnames with a verifying claim and drops the rest', async () => {
            const engine = await registered();
            const other = await createTestEngine();
            const claim = async (signer: TestEngine, hostname: string): Promise<HostnameClaim> => {
                const parsed = Hostname.parse(hostname);
                return {
                    hostname: parsed,
                    sig: ed25519SignatureFromBytes(await signHostnameClaim(signer.signer, parsed, engine.engineId)),
                };
            };
            const good = await claim(engine, 'agents.customer.test');
            harness.engineHostnames.set(engine.engineId, [good, await claim(other, 'forged.customer.test')]);
            const { token } = await mint();
            const response = await asRelay(token, engine.engineId);
            expect(RegistryEntry.parse(response.body)).toMatchObject({
                hostnames: [defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN), good.hostname],
                claims: [good],
            });
            expect(harness.logger.entries).toContainEqual({
                level: 'warn',
                event: 'registry.claims-dropped',
                fields: { engineId: engine.engineId, count: 1 },
            });
        });

        it('answers 404 for an unknown engine and 400 for a malformed engine ID', async () => {
            const { token } = await mint();
            const unknown = await createTestEngine();
            const missing = await asRelay(token, unknown.engineId);
            expect([missing.status, problemCode(missing)]).toEqual([404, 'not-found']);
            for (const path of ['/internal/v1/engines/NOT-AN-ID', `/internal/v1/engines/${unknown.engineId}x`]) {
                const malformed = await read(path, { Authorization: `Bearer ${token}` });
                expect([malformed.status, problemCode(malformed)]).toEqual([400, 'invalid-request']);
            }
        });

        it('refuses a missing header, a malformed token and a well-formed unknown token', async () => {
            const engine = await registered();
            const { token } = await mint();
            expectUnauthorized(await read(registryPath(engine.engineId)));
            for (const header of [
                token,
                `Basic ${token}`,
                `Bearer ${token.slice(0, -1)}`,
                `Bearer ${token}=`,
                `Bearer ${token.replace('ptbk_rt_', 'ptbk_xx_')}`,
                `Bearer  ${token}`,
            ]) {
                expectUnauthorized(await read(registryPath(engine.engineId), { Authorization: header }));
            }
            expectUnauthorized(await asRelay(newRelayToken(cryptoRandom), engine.engineId));
            expect(JSON.stringify(harness.logger.entries)).not.toContain(token);
        });

        it('refuses a revoked and an expired token', async () => {
            const engine = await registered();
            const now = harness.clock.nowMs();
            const revoked = await mint(RELAY, { revokedAt: now - 1 });
            const expired = await mint(RELAY, { expiresAt: now });
            expectUnauthorized(await asRelay(revoked.token, engine.engineId));
            expectUnauthorized(await asRelay(expired.token, engine.engineId));
        });

        it('lets two live tokens of one relay overlap, and revoking one leaves the other working', async () => {
            const engine = await registered();
            const old = await mint();
            const next = await mint();
            expect((await asRelay(old.token, engine.engineId)).status).toBe(200);
            expect((await asRelay(next.token, engine.engineId)).status).toBe(200);
            await fixture.revokeRelayToken(old.row.id, harness.clock.nowMs());
            expectUnauthorized(await asRelay(old.token, engine.engineId));
            expect((await asRelay(next.token, engine.engineId)).status).toBe(200);
        });

        it('does not take a session cookie for a relay key', async () => {
            const browser = await owner();
            const engine = await registered(browser);
            const response = await browser.request('GET', registryPath(engine.engineId));
            expectUnauthorized(response);
        });

        it('records last use at most once a minute', async () => {
            const engine = await registered();
            const { token, row } = await mint();
            const start = harness.clock.nowMs();
            await asRelay(token, engine.engineId);
            expect((await fixture.relayToken(row.id))?.lastUsedAt).toBe(start);
            harness.clock.advance(59_999);
            await asRelay(token, engine.engineId);
            expect((await fixture.relayToken(row.id))?.lastUsedAt).toBe(start);
            harness.clock.advance(1);
            await asRelay(token, engine.engineId);
            expect((await fixture.relayToken(row.id))?.lastUsedAt).toBe(start + 60_000);
        });

        it('limits each relay to its own budget per minute', async () => {
            const engine = await createTestEngine();
            const busy = await mint('relay-1.ptbk.test');
            const busySecond = await mint('relay-1.ptbk.test');
            const calm = await mint('relay-2.ptbk.test');
            const { limit } = RATE_LIMITS['registry-relay'];
            for (let i = 0; i < limit; i++) {
                expect((await asRelay(i % 2 === 0 ? busy.token : busySecond.token, engine.engineId)).status).toBe(404);
            }
            const limited = await asRelay(busy.token, engine.engineId);
            expect([limited.status, problemCode(limited)]).toEqual([429, 'rate-limited']);
            expect((await asRelay(calm.token, engine.engineId)).status).toBe(404);
        });
    });
}
