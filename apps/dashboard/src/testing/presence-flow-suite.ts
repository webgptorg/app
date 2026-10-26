import { LinkCode, REGISTER_PATH, type EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { cryptoRandom } from '../adapters/crypto-random';
import { newRelayToken, sha256Hex } from '../domain/auth/secrets';
import { newRelayTokenId, type RelayTokenId } from '../domain/ids';
import { PRESENCE_EXPIRY_MS } from '../domain/presence/relay-presence';
import { RATE_LIMITS } from '../domain/ports/rate-limiter';
import { MAX_PRESENCE_ENGINE_IDS, RELAY_PRESENCE_PATH } from '../shared/api/relay-presence';
import type { EngineView, LinkCodeView } from '../shared/api/routes';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import { problemCode, signUp } from './auth-flows';
import type { StoredRelayToken } from './memory-registry-stores';
import { presenceEngineIds } from './relay-presence-store-contract';
import { createTestEngine } from './test-engine';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PRESENCE_RELAYS = ['relay-a.ptbk.test', 'relay-b.ptbk.test'] as const;
const [RELAY_A, RELAY_B] = PRESENCE_RELAYS;

export interface PresenceFlowFixture {
    /** Built with `relays: PRESENCE_RELAYS`. */
    readonly harness: AuthHarness;
    /** Writes the row as `scripts/mint-relay-key.ts` does. */
    addRelayToken(row: StoredRelayToken): Promise<void>;
    /** What `--revoke` does. */
    revokeRelayToken(id: RelayTokenId, at: number): Promise<void>;
}

/**
 * R-07's acceptance tests over HTTP: relays report their ready tunnels with their relay key, and the engine views
 * carry the count. Runs on the in-memory stores (unit project) and on D1 (workers project).
 */
export function describePresenceFlows(name: string, makeFixture: () => PresenceFlowFixture): void {
    describe(name, () => {
        let fixture: PresenceFlowFixture;
        let harness: AuthHarness;
        let owner: TestBrowser;

        beforeEach(async () => {
            fixture = makeFixture();
            harness = fixture.harness;
            owner = harness.browser({ ip: '203.0.113.1' });
            await signUp(harness, owner);
            expect((await owner.request('POST', '/api/billing/checkout', { planId: 'starter' })).status).toBe(200);
        });

        async function mint(
            relayId: string,
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

        async function registered(): Promise<EngineId> {
            const view = (await owner.request('POST', '/api/engines/link-codes')).body as LinkCodeView;
            const engine = await createTestEngine();
            const request = await engine.register(LinkCode.parse(view.linkCode));
            expect((await harness.browser({ ip: '198.51.100.7' }).request('POST', REGISTER_PATH, request)).status).toBe(
                200,
            );
            return engine.engineId;
        }

        function report(token: string | null, body: unknown): Promise<TestResponse> {
            return harness
                .browser({ ip: '192.0.2.50' })
                .request('PUT', RELAY_PRESENCE_PATH, body, token === null ? {} : { Authorization: `Bearer ${token}` });
        }

        async function reachable(engineId: EngineId): Promise<number | null> {
            const detail = (await owner.request('GET', `/api/engines/${engineId}`)).body as { engine: EngineView };
            const list = (await owner.request('GET', '/api/engines')).body as { engines: readonly EngineView[] };
            const listed = list.engines.find((engine) => engine.engineId === engineId);
            expect(listed?.reachableRelays).toBe(detail.engine.reachableRelays);
            return detail.engine.reachableRelays;
        }

        function expectProblem(response: TestResponse, status: number, code: string): void {
            expect([response.status, problemCode(response)]).toEqual([status, code]);
        }

        it('counts the relays whose latest full report lists the engine', async () => {
            const engine = await registered();
            const other = await registered();
            const a = await mint(RELAY_A);
            const b = await mint(RELAY_B);
            expect(await reachable(engine)).toBeNull();
            expect((await report(a.token, { v: 1, engineIds: [engine] })).status).toBe(204);
            expect(await reachable(engine)).toBe(1);
            expect(await reachable(other)).toBe(0);
            expect((await report(b.token, { v: 1, engineIds: [other, engine] })).status).toBe(204);
            expect(await reachable(engine)).toBe(2);
            expect(await reachable(other)).toBe(1);
            // A full list, not a delta: what a report leaves out is no longer reachable through that relay.
            expect((await report(a.token, { v: 1, engineIds: [] })).status).toBe(204);
            expect(await reachable(engine)).toBe(1);
        });

        it('expires a relay’s entries 3 minutes after its last report', async () => {
            const engine = await registered();
            const a = await mint(RELAY_A);
            const b = await mint(RELAY_B);
            await report(a.token, { v: 1, engineIds: [engine] });
            harness.clock.advance(60_000);
            await report(b.token, { v: 1, engineIds: [] });
            harness.clock.advance(PRESENCE_EXPIRY_MS - 60_000 - 1);
            expect(await reachable(engine)).toBe(1);
            harness.clock.advance(1);
            expect(await reachable(engine)).toBe(0);
            harness.clock.advance(60_000);
            // No relay report is live any more: nothing is known, rather than "not reachable".
            expect(await reachable(engine)).toBeNull();
        });

        it('takes the relay from its key, never from the body', async () => {
            const engine = await registered();
            const a = await mint(RELAY_A);
            const b = await mint(RELAY_B);
            await report(a.token, { v: 1, engineIds: [engine] });
            // Relay B's empty list replaces only B's entries.
            expect((await report(b.token, { v: 1, engineIds: [] })).status).toBe(204);
            expect(await reachable(engine)).toBe(1);
            expectProblem(await report(b.token, { v: 1, engineIds: [], relayId: RELAY_A }), 400, 'invalid-request');
            expect(await reachable(engine)).toBe(1);
        });

        it('refuses unknown fields, other versions, malformed or repeated engine IDs and non-JSON bodies', async () => {
            const engine = await registered();
            const { token } = await mint(RELAY_A);
            for (const body of [
                { v: 1, engineIds: [engine], extra: true },
                { v: 2, engineIds: [engine] },
                { engineIds: [engine] },
                { v: 1 },
                { v: 1, engineIds: ['NOT-AN-ENGINE-ID'] },
                { v: 1, engineIds: [engine, engine] },
                { v: 1, engineIds: engine },
                [engine],
                'v=1',
            ]) {
                expectProblem(await report(token, body), 400, 'invalid-request');
            }
            expect(await reachable(engine)).toBeNull();
        });

        it('refuses a missing, malformed, unknown, revoked or expired key', async () => {
            const engine = await registered();
            const now = harness.clock.nowMs();
            const live = await mint(RELAY_A);
            const revoked = await mint(RELAY_A, { revokedAt: now - 1 });
            const expired = await mint(RELAY_A, { expiresAt: now });
            const body = { v: 1, engineIds: [engine] };
            expectProblem(await report(null, body), 401, 'unauthorized');
            expectProblem(await report(live.token.slice(0, -1), body), 401, 'unauthorized');
            expectProblem(await report(newRelayToken(cryptoRandom), body), 401, 'unauthorized');
            expectProblem(await report(revoked.token, body), 401, 'unauthorized');
            expectProblem(await report(expired.token, body), 401, 'unauthorized');
            await fixture.revokeRelayToken(live.row.id, now);
            expectProblem(await report(live.token, body), 401, 'unauthorized');
            expect(await reachable(engine)).toBeNull();
            expect(JSON.stringify(harness.logger.entries)).not.toContain(live.token);
        });

        it('does not take a session cookie for a relay key', async () => {
            const engine = await registered();
            expectProblem(
                await owner.request('PUT', RELAY_PRESENCE_PATH, { v: 1, engineIds: [engine] }),
                401,
                'unauthorized',
            );
        });

        it('refuses a relay that is not in RELAYS', async () => {
            const engine = await registered();
            const stranger = await mint('relay-x.ptbk.test');
            expectProblem(await report(stranger.token, { v: 1, engineIds: [engine] }), 403, 'unknown-relay');
            expect(await reachable(engine)).toBeNull();
        });

        it('takes a report at the cap and refuses one over it as too large', async () => {
            const { token } = await mint(RELAY_A);
            const ids = presenceEngineIds(MAX_PRESENCE_ENGINE_IDS + 1);
            expectProblem(await report(token, { v: 1, engineIds: ids }), 413, 'too-large');
            expect((await report(token, { v: 1, engineIds: ids.slice(1) })).status).toBe(204);
        });

        it('limits each relay to its own budget per minute', async () => {
            const a = await mint(RELAY_A);
            const b = await mint(RELAY_B);
            const { limit } = RATE_LIMITS['presence-relay'];
            for (let i = 0; i < limit; i++) {
                expect((await report(a.token, { v: 1, engineIds: [] })).status).toBe(204);
            }
            expectProblem(await report(a.token, { v: 1, engineIds: [] }), 429, 'rate-limited');
            expect((await report(b.token, { v: 1, engineIds: [] })).status).toBe(204);
        });
    });
}
