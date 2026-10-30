import {
    defaultHostname,
    deriveEngineId,
    ed25519PublicKeyToBytes,
    EngineVersion,
    RegisterEngineResponse,
    type LinkCode,
    type RegisterEngineRequest,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestEngine, TEST_ENGINE_DOMAIN, type TestEngine } from '../../testing/test-engine';
import {
    createTestRegistration as setup,
    REGISTRATION_START_MS as NOW,
    TEST_RELAYS as RELAYS,
} from '../../testing/test-registration';
import { sha256Hex } from '../auth/secrets';
import { LINK_CODE_TTL_MS } from './issue-link-code';

async function expectedResponse(engine: TestEngine): Promise<RegisterEngineResponse> {
    const engineId = await deriveEngineId(ed25519PublicKeyToBytes(engine.publicKey));
    return { engineId, hostname: defaultHostname(engineId, TEST_ENGINE_DOMAIN), relays: RELAYS, memberKey: null };
}

describe('registerEngine', () => {
    it('links the engine to the link code organization and answers C-03’s response', async () => {
        const t = setup();
        const org = testOrgId();
        const engine = await createTestEngine();
        const code = await t.issue(org);
        const outcome = await t.register(await engine.register(code, { engineVersion: '1.2.3', mode: 'direct' }));
        expect(outcome).toEqual({ kind: 'registered', response: await expectedResponse(engine) });
        expect(RegisterEngineResponse.parse(outcome.kind === 'registered' ? outcome.response : null)).toBeTruthy();
        expect(t.stores.state.engines.get(engine.engineId)).toMatchObject({
            orgId: org,
            publicKey: engine.publicKey,
            mode: 'direct',
            engineVersion: '1.2.3',
            status: 'active',
            createdAt: NOW,
        });
        expect(await t.unused(code)).toBe(false);
    });

    it('logs the engine ID and the outcome, never the code or its hash', async () => {
        const t = setup();
        const engine = await createTestEngine();
        const code = await t.issue(testOrgId());
        await t.register(await engine.register(code));
        expect(t.logger.entries).toEqual([
            {
                level: 'info',
                event: 'engine.registration',
                fields: { outcome: 'registered', engineId: engine.engineId },
            },
        ]);
        const logged = JSON.stringify(t.logger.entries);
        expect(logged).not.toContain(code);
        expect(logged).not.toContain(await sha256Hex(code));
    });

    it('refuses an expired code 30 minutes and 1 second after issuance', async () => {
        const t = setup();
        const engine = await createTestEngine();
        const code = await t.issue(testOrgId());
        t.clock.advance(LINK_CODE_TTL_MS + 1000);
        expect(await t.register(await engine.register(code))).toEqual({ kind: 'invalid-link-code' });
        expect(t.stores.state.engines.size).toBe(0);
    });

    it('refuses a used and an unknown code with the same outcome', async () => {
        const t = setup();
        const code = await t.issue(testOrgId());
        await t.register(await (await createTestEngine()).register(code));
        const second = await createTestEngine();
        expect(await t.register(await second.register(code))).toEqual({ kind: 'invalid-link-code' });
        const unknown = 'aaaaaaaaaaaaaaaaaaaaaaaaaa' as LinkCode;
        expect(await t.register(await second.register(unknown))).toEqual({ kind: 'invalid-link-code' });
        expect(t.stores.state.engines.has(second.engineId)).toBe(false);
    });

    it.each([
        [
            'a signature from another key',
            async (request: RegisterEngineRequest) => {
                const other = await createTestEngine();
                return { ...request, sig: (await other.register(request.linkCode)).sig };
            },
        ],
        [
            'mode changed after signing',
            (request: RegisterEngineRequest) => Promise.resolve({ ...request, mode: 'direct' as const }),
        ],
        [
            'engineVersion changed after signing',
            (request: RegisterEngineRequest) =>
                Promise.resolve({ ...request, engineVersion: EngineVersion.parse('9.9.9') }),
        ],
    ])('refuses %s with bad-signature and leaves the code unused', async (_, tamper) => {
        const t = setup();
        const code = await t.issue(testOrgId());
        const request = await tamper(await (await createTestEngine()).register(code));
        expect(await t.register(request)).toEqual({ kind: 'bad-signature' });
        expect(await t.unused(code)).toBe(true);
        expect(t.stores.state.engines.size).toBe(0);
        expect(t.logger.entries).toEqual([
            { level: 'info', event: 'engine.registration', fields: { outcome: 'bad-signature' } },
        ]);
    });

    it('re-registers the same key from the same organization idempotently, updating version and mode', async () => {
        const t = setup();
        const org = testOrgId();
        const engine = await createTestEngine();
        const first = await t.register(await engine.register(await t.issue(org)));
        t.clock.advance(1000);
        const code = await t.issue(org);
        const second = await t.register(await engine.register(code, { engineVersion: '2.0.0', mode: 'direct' }));
        expect(second).toEqual(first);
        expect(t.stores.state.engines.size).toBe(1);
        expect(t.stores.state.engines.get(engine.engineId)).toMatchObject({
            orgId: org,
            engineVersion: '2.0.0',
            mode: 'direct',
            createdAt: NOW,
            updatedAt: NOW + 1000,
        });
        expect(await t.unused(code)).toBe(false);
    });

    it('refuses the same key with another organization’s code and leaves that code unused', async () => {
        const t = setup();
        const engine = await createTestEngine();
        await t.register(await engine.register(await t.issue(testOrgId())));
        const foreign = await t.issue(testOrgId());
        expect(await t.register(await engine.register(foreign))).toEqual({ kind: 'engine-exists' });
        expect(await t.unused(foreign)).toBe(true);
    });

    it.each(['owner-revoked', 'platform-suspended'])('refuses a %s engine', async (reason) => {
        const t = setup();
        const org = testOrgId();
        const engine = await createTestEngine();
        await t.register(await engine.register(await t.issue(org)));
        const stored = t.stores.state.engines.get(engine.engineId);
        if (stored === undefined) {
            throw new Error('engine not stored');
        }
        t.stores.state.engines.set(engine.engineId, { ...stored, status: 'suspended', statusReason: reason });
        for (const code of [await t.issue(org), await t.issue(testOrgId())]) {
            expect(await t.register(await engine.register(code))).toEqual({ kind: 'engine-suspended' });
            expect(await t.unused(code)).toBe(true);
        }
    });

    it('refuses a new engine without engines.create, and at engines.max, leaving the code unused', async () => {
        const t = setup();
        const org = testOrgId();
        const code = await t.issue(org);
        t.entitlements.grant(org, { enginesCreate: false });
        expect(await t.register(await (await createTestEngine()).register(code))).toEqual({ kind: 'not-entitled' });
        expect(await t.unused(code)).toBe(true);
        t.entitlements.grant(org, { enginesCreate: true, enginesMax: 1 });
        const first = await createTestEngine();
        expect((await t.register(await first.register(code))).kind).toBe('registered');
        const next = await t.issue(org).catch(() => null);
        expect(next).toBeNull();
        t.entitlements.grant(org, { enginesMax: 2 });
        const other = await t.issue(org);
        t.entitlements.grant(org, { enginesMax: 1 });
        expect(await t.register(await (await createTestEngine()).register(other))).toEqual({ kind: 'engine-limit' });
        expect(await t.unused(other)).toBe(true);
        // The existing engine re-links at its quota: re-registration creates nothing.
        expect((await t.register(await first.register(other))).kind).toBe('registered');
    });

    it('retries once when a concurrent registration of the same key won, and answers as re-registration', async () => {
        let raced = false;
        const t = setup({
            wrapLinkCodes: (store, stores) => ({
                ...store,
                async redeemForNewEngine(codeHash, engine) {
                    if (!raced) {
                        raced = true;
                        stores.state.engines.set(engine.engineId, engine);
                        return 'conflict';
                    }
                    return store.redeemForNewEngine(codeHash, engine);
                },
            }),
        });
        const engine = await createTestEngine();
        const code = await t.issue(testOrgId());
        expect(await t.register(await engine.register(code))).toEqual({
            kind: 'registered',
            response: await expectedResponse(engine),
        });
        expect(await t.unused(code)).toBe(false);
    });

    it('answers invalid-link-code when it loses the race twice', async () => {
        const t = setup({
            wrapLinkCodes: (store) => ({
                ...store,
                redeemForNewEngine: () => Promise.resolve('conflict'),
                redeemForExistingEngine: () => Promise.resolve('conflict'),
            }),
        });
        const code = await t.issue(testOrgId());
        expect(await t.register(await (await createTestEngine()).register(code))).toEqual({
            kind: 'invalid-link-code',
        });
        expect(await t.unused(code)).toBe(true);
    });

    it('sees a suspension that raced a re-registration', async () => {
        const t = setup({
            wrapLinkCodes: (store, stores) => ({
                ...store,
                redeemForExistingEngine(codeHash, refresh) {
                    const engine = stores.state.engines.get(refresh.engineId);
                    if (engine !== undefined) {
                        stores.state.engines.set(refresh.engineId, { ...engine, status: 'suspended' });
                    }
                    return store.redeemForExistingEngine(codeHash, refresh);
                },
            }),
        });
        const org = testOrgId();
        const engine = await createTestEngine();
        await t.register(await engine.register(await t.issue(org)));
        const code = await t.issue(org);
        expect(await t.register(await engine.register(code))).toEqual({ kind: 'engine-suspended' });
        expect(await t.unused(code)).toBe(true);
    });
});
