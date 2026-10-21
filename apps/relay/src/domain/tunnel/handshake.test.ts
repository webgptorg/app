import type { EngineId, Hostname, RegistryEntry, TunnelAuth, TunnelChallenge, TunnelFeature } from '@ptbk/protocol';
import {
    EngineVersion,
    Hostname as HostnameSchema,
    NONCE_BYTES,
    RelayId,
    TunnelChallenge as TunnelChallengeSchema,
    TunnelFeature as TunnelFeatureSchema,
    decodeBase64Url,
    expectedCnameTarget,
    signTunnelAuth,
} from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TestEngine } from '../../testing/engines';
import { ENGINE_DOMAIN, createTestEngine } from '../../testing/engines';
import { createFakeRandom } from '../../testing/fake-random';
import type { TestDeps } from '../../testing/test-deps';
import { createTestDeps } from '../../testing/test-deps';
import type { HandshakeOutcome, HandshakeRejectReason, RelayTunnelOffer } from './handshake';
import { createChallenge, verifyAuth } from './handshake';

const RELAY_A = RelayId.parse('relay-a.ptbk.test');
const RELAY_B = RelayId.parse('relay-b.ptbk.test');
const VERSION = EngineVersion.parse('1.8.2');
const features = (...names: string[]): TunnelFeature[] => names.map((name) => TunnelFeatureSchema.parse(name));
const RELAY_OFFER: RelayTunnelOffer = { versions: [1, 2, 3], features: features('a', 'b') };
const ENGINE_OFFER = { version: VERSION, protocolVersions: [2, 3, 4], features: features('b', 'c') };
const agents = HostnameSchema.parse('agents.customer.test');
const portal = HostnameSchema.parse('portal.customer.test');
const wrongTarget = HostnameSchema.parse('evil.customer.test');

describe('createChallenge', () => {
    it('draws a fresh nonce from the Random port and announces the relay offer', () => {
        const random = createFakeRandom();
        const first = createChallenge(random, RELAY_A, RELAY_OFFER);
        const second = createChallenge(random, RELAY_A, RELAY_OFFER);
        expect(random.calls()).toBe(2);
        expect(first.nonce).toHaveLength(NONCE_BYTES);
        expect(first.challenge).toEqual({
            v: 1,
            type: 'challenge',
            nonce: first.challenge.nonce,
            relayId: RELAY_A,
            protocolVersions: [1, 2, 3],
            features: ['a', 'b'],
        });
        expect(TunnelChallengeSchema.parse(first.challenge)).toEqual(first.challenge);
        const decoded = decodeBase64Url(first.challenge.nonce);
        expect(decoded.kind === 'ok' && decoded.bytes).toEqual(first.nonce);
        expect(second.challenge.nonce).not.toBe(first.challenge.nonce);
        expect(second.nonce).not.toEqual(first.nonce);
    });

    it('throws on an offer outside C-02 bounds, a bug in the relay', () => {
        expect(() => createChallenge(createFakeRandom(), RELAY_A, { versions: [], features: [] })).toThrow();
    });
});

describe('verifyAuth', () => {
    let engine: TestEngine;
    let deps: TestDeps;
    let challenge: TunnelChallenge;

    beforeEach(async () => {
        engine = await createTestEngine(50, [agents, portal]);
        deps = createTestDeps();
        deps.registry.set(engine.engineId, engine.entry);
        ({ challenge } = createChallenge(createFakeRandom(), RELAY_A, RELAY_OFFER));
    });

    const sign = async (
        over: TunnelChallenge = challenge,
        offer: typeof ENGINE_OFFER = ENGINE_OFFER,
        signer = engine.signer,
    ): Promise<TunnelAuth> => {
        const signed = await signTunnelAuth(signer, over, offer, { dialledRelayId: over.relayId });
        if (signed.kind !== 'signed') throw new Error('expected a signed auth');
        return signed.auth;
    };

    let admitLookup: (engineId: EngineId) => boolean;
    beforeEach(() => {
        admitLookup = () => true;
    });

    const verify = (auth: unknown, against: TunnelChallenge = challenge, signal = new AbortController().signal) =>
        verifyAuth({
            auth: typeof auth === 'string' ? auth : JSON.stringify(auth),
            challenge: against,
            registry: deps.registry,
            admitLookup: (engineId) => admitLookup(engineId),
            dns: deps.dns,
            engineDomain: ENGINE_DOMAIN,
            logger: deps.logger,
            signal,
        });

    const rejected = (reason: HandshakeRejectReason): HandshakeOutcome => ({
        kind: 'rejected',
        reason,
        engineId: engine.engineId,
    });

    it('accepts a valid auth with the highest common version and exactly the shared features', async () => {
        const expected = expectedCnameTarget(engine.engineId, ENGINE_DOMAIN);
        deps.dns.setAnswer(agents, { kind: 'cname', target: expected });
        deps.dns.setAnswer(portal, { kind: 'cname', target: expected });
        await expect(verify(await sign())).resolves.toEqual({
            kind: 'accepted',
            engineId: engine.engineId,
            hostnames: [engine.defaultHostname, agents, portal],
            protocolVersion: 3,
            features: ['b'],
        });
    });

    it('routes the default hostname and a custom one with a valid claim and CNAME, not an invalid claim or wrong CNAME', async () => {
        const stranger = await createTestEngine(51, [portal]);
        const forgedClaims = engine.entry.claims.map((claim) =>
            claim.hostname === portal ? (stranger.entry.claims[0] ?? claim) : claim,
        );
        const misdirected = HostnameSchema.parse('wrong.customer.test');
        const withMisdirected = await createTestEngine(50, [agents, portal, misdirected]);
        deps.registry.set(engine.engineId, {
            ...withMisdirected.entry,
            claims: [...forgedClaims, ...withMisdirected.entry.claims.filter((c) => c.hostname === misdirected)],
        });
        const expected = expectedCnameTarget(engine.engineId, ENGINE_DOMAIN);
        deps.dns.setAnswer(agents, { kind: 'cname', target: expected });
        deps.dns.setAnswer(portal, { kind: 'cname', target: expected });
        deps.dns.setAnswer(misdirected, { kind: 'cname', target: wrongTarget });
        const outcome = await verify(await sign());
        expect(outcome).toMatchObject({ kind: 'accepted', hostnames: [engine.defaultHostname, agents] });
    });

    it('announces at most 32 hostnames, keeping the default one first', async () => {
        const customs: Hostname[] = Array.from({ length: 32 }, (_, index) =>
            HostnameSchema.parse(`h${String(index)}.customer.test`),
        );
        const crowded = await createTestEngine(50, customs);
        const entry: RegistryEntry = { ...crowded.entry, hostnames: customs };
        deps.registry.set(engine.engineId, entry);
        const expected = expectedCnameTarget(engine.engineId, ENGINE_DOMAIN);
        for (const hostname of customs) deps.dns.setAnswer(hostname, { kind: 'cname', target: expected });
        const outcome = await verify(await sign());
        expect(outcome.kind === 'accepted' && outcome.hostnames).toEqual([
            engine.defaultHostname,
            ...customs.slice(0, 31),
        ]);
    });

    describe('rejects as bad-signature', () => {
        it('an auth signed over a stripped relay version list (downgrade)', async () => {
            const stripped = { ...challenge, protocolVersions: [1] };
            await expect(verify(await sign(stripped))).resolves.toEqual(rejected('bad-signature'));
        });

        it('an auth signed over an altered relay feature list', async () => {
            const altered = { ...challenge, features: features('a') };
            await expect(verify(await sign(altered))).resolves.toEqual(rejected('bad-signature'));
        });

        it('an engine version list stripped after signing', async () => {
            const auth = await sign();
            await expect(verify({ ...auth, protocolVersions: [2] })).resolves.toEqual(rejected('bad-signature'));
        });

        it('an engine feature list altered after signing', async () => {
            const auth = await sign();
            await expect(verify({ ...auth, features: features('c') })).resolves.toEqual(rejected('bad-signature'));
        });

        it('an engine software version changed after signing', async () => {
            const auth = await sign();
            await expect(verify({ ...auth, version: '1.8.3' })).resolves.toEqual(rejected('bad-signature'));
        });

        it('a signature by another key', async () => {
            const other = await createTestEngine(52);
            const auth = await sign(challenge, ENGINE_OFFER, other.signer);
            await expect(verify({ ...auth, engineId: engine.engineId })).resolves.toEqual(rejected('bad-signature'));
        });

        it('a replayed auth from an earlier challenge (another nonce)', async () => {
            const random = createFakeRandom();
            const earlier = createChallenge(random, RELAY_A, RELAY_OFFER).challenge;
            const current = createChallenge(random, RELAY_A, RELAY_OFFER).challenge;
            await expect(verify(await sign(earlier), current)).resolves.toEqual(rejected('bad-signature'));
        });

        it('an auth for a challenge from another relay', async () => {
            const forRelayB = { ...challenge, relayId: RELAY_B };
            await expect(verify(await sign(forRelayB))).resolves.toEqual(rejected('bad-signature'));
        });
    });

    it('rejects an engine whose ID does not derive from the registry key as id-key-mismatch', async () => {
        const other = await createTestEngine(53);
        deps.registry.set(engine.engineId, other.entry);
        await expect(verify(await sign())).resolves.toEqual(rejected('id-key-mismatch'));
    });

    it('rejects a validly signed engine offering only unknown versions as unsupported-version', async () => {
        const auth = await sign(challenge, { ...ENGINE_OFFER, protocolVersions: [7, 9] });
        await expect(verify(auth)).resolves.toEqual(rejected('unsupported-version'));
    });

    it('rejects a suspended engine after verifying its signature', async () => {
        deps.registry.set(engine.engineId, { ...engine.entry, status: 'suspended' });
        await expect(verify(await sign())).resolves.toEqual(rejected('suspended'));
        const forged = { ...(await sign()), version: '9.9.9' };
        await expect(verify(forged)).resolves.toEqual(rejected('bad-signature'));
    });

    it('rejects an engine the registry does not know as unknown-engine', async () => {
        deps.registry.delete(engine.engineId);
        await expect(verify(await sign())).resolves.toEqual(rejected('unknown-engine'));
    });

    it('rejects as registry-unavailable when the registry cannot answer and nothing is cached', async () => {
        deps.registry.setMode('unavailable');
        await expect(verify(await sign())).resolves.toEqual(rejected('registry-unavailable'));
    });

    it.each([
        ['an unknown field', (auth: TunnelAuth) => JSON.stringify({ ...auth, extra: true })],
        ['invalid JSON', () => '{'],
        ['another message type', () => JSON.stringify(challenge)],
        ['an oversize message', (auth: TunnelAuth) => JSON.stringify({ ...auth, pad: 'x'.repeat(5000) })],
    ])('rejects %s as malformed without an engine ID and without a lookup', async (_, build) => {
        const text = build(await sign());
        await expect(verify(text)).resolves.toEqual({ kind: 'rejected', reason: 'malformed' });
        expect(deps.registry.calls()).toBe(0);
    });

    it('rejects with the abort reason once the signal aborts', async () => {
        deps.registry.setMode('hang');
        const controller = new AbortController();
        const pending = verify(await sign(), challenge, controller.signal);
        controller.abort(new Error('closed'));
        await expect(pending).rejects.toThrow('closed');
    });

    it('logs no nonce, signature or key', async () => {
        const stranger = await createTestEngine(51, [portal]);
        deps.registry.set(engine.engineId, {
            ...engine.entry,
            claims: engine.entry.claims.map((claim) =>
                claim.hostname === portal ? (stranger.entry.claims[0] ?? claim) : claim,
            ),
        });
        const auth = await sign();
        await verify(auth);
        expect(deps.logger.entries.length).toBeGreaterThan(0);
        const logged = JSON.stringify(deps.logger.entries);
        for (const secret of [challenge.nonce, auth.sig, engine.entry.enginePublicKey, agents, portal]) {
            expect(logged).not.toContain(secret);
        }
    });

    it('refuses as rate-limited without asking the registry when the lookup is not admitted', async () => {
        const asked: EngineId[] = [];
        admitLookup = (engineId) => {
            asked.push(engineId);
            return false;
        };
        deps.registry.set(engine.engineId, { ...engine.entry, status: 'suspended' });
        await expect(verify(await sign())).resolves.toEqual(rejected('rate-limited'));
        expect(asked).toEqual([engine.engineId]);
        expect(deps.registry.calls()).toBe(0);
    });
});
