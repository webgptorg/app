import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { createFakeCeremonies } from '../../testing/fake-passkey-ceremonies';
import { createMemoryLogger } from '../../testing/memory-logger';
import { createSeededRandom } from '../../testing/seeded-random';
import { createTestRuntime } from '../../testing/test-runtime';
import { hasOwner, membersWhoCanSignIn } from '../onboarding/owner';
import { createInMemorySetupSecretStore, createSetupSecrets } from '../onboarding/setup-secret';
import type { Challenges, RelyingParty } from './passkey-ceremonies';
import { CHALLENGE_LIFETIME_MS, MAX_PENDING_CHALLENGES, createChallenges } from './passkey-ceremonies';
import type { PasskeyStore } from './passkey-gateway';
import { createInMemoryPasskeyStore, createPasskeyGateway } from './passkey-gateway';
import { createSessionStore } from './sessions';

const HOSTNAME = 'abcdefghijklmnopqrstuvwxyz.engines.ptbk.test';
const RP: RelyingParty = { id: HOSTNAME, origin: `https://${HOSTNAME}` };
const CLIENT = { ip: '203.0.113.9', userAgent: 'test browser' };

async function setup(options: { readonly passkeys?: PasskeyStore; readonly seeded?: boolean } = {}) {
    const clock = createFakeClock(Date.parse('2026-10-26T10:00:00Z'));
    const runtime = await createTestRuntime({
        seed: 7,
        scenario: 'small-team',
        epoch: new Date('2026-10-01T00:00:00Z'),
        identity: { engineId: 'abcdefghijklmnopqrstuvwxyz', hostname: HOSTNAME, mode: 'tunnel', version: '0.1.0' },
        clock,
        passkeys: options.seeded === true ? 'seeded' : 'none',
    });
    const random = createSeededRandom(11);
    const logger = createMemoryLogger();
    const sessions = createSessionStore({ engine: () => runtime.controller(), clock, random });
    const ownerSetUp = () => hasOwner(runtime.controller().inspect());
    const secrets = createSetupSecrets({
        store: createInMemorySetupSecretStore(),
        random,
        clock,
        hasOwner: ownerSetUp,
    });
    const ceremonies = createFakeCeremonies();
    const passkeys = options.passkeys ?? createInMemoryPasskeyStore();
    let ownerChanges = 0;
    const gateway = createPasskeyGateway({
        engine: () => runtime.controller(),
        sessions,
        secrets,
        passkeys,
        ceremonies,
        challenges: createChallenges({ random, clock }),
        random,
        clock,
        logger,
        onOwnerChanged: () => {
            ownerChanges++;
        },
    });
    async function secret(): Promise<string> {
        const issued = await secrets.issue();
        if (issued.kind !== 'issued') throw new Error(issued.kind);
        return issued.secret.reveal();
    }
    /** The browser's whole setup: options with the secret, a new credential, then verify with the secret again. */
    async function becomeOwner(value: string, credentialId = 'credential-owner') {
        const options = await gateway.setupOptions({ secret: value, rp: RP });
        if (options.kind !== 'options') return options;
        return gateway.completeSetup({
            secret: value,
            response: ceremonies.register(options.options, credentialId, RP),
            rp: RP,
            client: CLIENT,
        });
    }
    async function signIn(credentialId: string) {
        const options = await gateway.signInOptions(RP);
        return gateway.signIn({ response: ceremonies.assert(options, credentialId, RP), rp: RP, client: CLIENT });
    }
    return {
        clock,
        runtime,
        sessions,
        secrets,
        passkeys,
        ceremonies,
        gateway,
        logger,
        secret,
        becomeOwner,
        signIn,
        ownerSetUp,
        ownerChanges: () => ownerChanges,
    };
}

describe('setup', () => {
    it('makes the existing owner the passkey holder, signs them in and audits it with the client IP', async () => {
        const world = await setup();
        const owner = world.runtime
            .controller()
            .inspect()
            .members.find(({ role }) => role === 'owner');
        expect(world.ownerSetUp()).toBe(false);
        const outcome = await world.becomeOwner(await world.secret());
        if (outcome.kind !== 'owner') throw new Error(outcome.kind);
        expect(world.ownerSetUp()).toBe(true);
        expect(world.ownerChanges()).toBe(1);
        const snapshot = world.runtime.controller().inspect();
        const passkey = snapshot.passkeys.find(({ memberId }) => memberId === owner?.id);
        expect(passkey).toMatchObject({
            name: 'Built-in passkey',
            authenticator: { attachment: 'platform', backedUp: true },
        });
        expect(membersWhoCanSignIn(snapshot)).toBe(1);
        const auth = world.sessions.authenticate(outcome.token, CLIENT);
        expect(auth).toMatchObject({ kind: 'signed-in', actor: { memberId: owner?.id, stepUpFresh: true } });
        expect(snapshot.sessions.find(({ memberId }) => memberId === owner?.id)?.passkeyId).toBe(passkey?.id);
        expect(await world.passkeys.list()).toMatchObject([{ credentialId: 'credential-owner', memberId: owner?.id }]);
        expect(world.logger.entries).toEqual([{ level: 'info', event: 'owner.passkey-registered', fields: {} }]);
    });

    it('refuses a reused secret and a second owner, whatever the secret', async () => {
        const world = await setup();
        const first = await world.secret();
        expect((await world.becomeOwner(first)).kind).toBe('owner');
        expect(await world.becomeOwner(first, 'credential-thief')).toEqual({ kind: 'owner-exists' });
        await expect(world.secrets.issue()).resolves.toEqual({ kind: 'owner-exists' });
        expect(await world.passkeys.list()).toHaveLength(1);
    });

    it('answers a wrong and an expired secret the same, and keeps the secret when the passkey does not verify', async () => {
        const world = await setup();
        const value = await world.secret();
        expect(await world.gateway.setupOptions({ secret: 'B'.repeat(22), rp: RP })).toEqual({ kind: 'invalid' });
        const options = await world.gateway.setupOptions({ secret: value, rp: RP });
        if (options.kind !== 'options') throw new Error(options.kind);
        const foreignOrigin = world.ceremonies.register(options.options, 'credential-x', {
            id: RP.id,
            origin: 'https://attacker.example',
        });
        expect(
            await world.gateway.completeSetup({ secret: value, response: foreignOrigin, rp: RP, client: CLIENT }),
        ).toEqual({ kind: 'not-verified' });
        // The challenge went with the failed attempt, but the secret did not: the owner can try again.
        expect(await world.secrets.check(value)).toBe('valid');
        expect((await world.becomeOwner(value)).kind).toBe('owner');
        const expired = await setup();
        const old = await expired.secret();
        expired.clock.advance(30 * 60_000);
        expect(await expired.becomeOwner(old)).toEqual({ kind: 'invalid' });
    });

    it('refuses a registration answering a sign-in challenge', async () => {
        const world = await setup();
        const value = await world.secret();
        const signInOptions = await world.gateway.signInOptions(RP);
        const response = world.ceremonies.register(signInOptions, 'credential-x', RP);
        expect(await world.gateway.completeSetup({ secret: value, response, rp: RP, client: CLIENT })).toEqual({
            kind: 'not-verified',
        });
    });
});

describe('sign-in and step-up', () => {
    it('signs the owner in again with their passkey and records its use', async () => {
        const world = await setup();
        await world.becomeOwner(await world.secret());
        world.clock.advance(60_000);
        const outcome = await world.signIn('credential-owner');
        if (outcome.kind !== 'verified') throw new Error(outcome.kind);
        expect(world.sessions.authenticate(outcome.token, CLIENT).kind).toBe('signed-in');
        expect(await world.passkeys.list()).toMatchObject([{ counter: 1 }]);
        const passkey = world.runtime
            .controller()
            .inspect()
            .passkeys.find(({ name }) => name === 'Built-in passkey');
        expect(passkey?.lastUsedAt).toBe('2026-10-26T10:01:00Z');
    });

    it('refuses an unknown credential, a replayed challenge, another RP and a passkey revoked through the API', async () => {
        const world = await setup();
        await world.becomeOwner(await world.secret());
        expect(await world.signIn('credential-unknown')).toEqual({ kind: 'not-recognised' });
        const otherOptions = await world.gateway.signInOptions(RP);
        const forOtherSite = world.ceremonies.assert(otherOptions, 'credential-owner', {
            id: 'other.example',
            origin: 'https://other.example',
        });
        expect(await world.gateway.signIn({ response: forOtherSite, rp: RP, client: CLIENT })).toEqual({
            kind: 'not-recognised',
        });
        const options = await world.gateway.signInOptions(RP);
        const response = world.ceremonies.assert(options, 'credential-owner', RP);
        expect((await world.gateway.signIn({ response, rp: RP, client: CLIENT })).kind).toBe('verified');
        expect(await world.gateway.signIn({ response, rp: RP, client: CLIENT })).toEqual({ kind: 'not-recognised' });
        const controller = world.runtime.controller();
        const passkey = controller.inspect().passkeys.find(({ name }) => name === 'Built-in passkey');
        controller.removePasskey(passkey?.id ?? '');
        expect(await world.signIn('credential-owner')).toEqual({ kind: 'not-recognised' });
    });

    it('confirms a step-up only with the session member’s own passkey and a challenge for that session', async () => {
        const world = await setup();
        const outcome = await world.becomeOwner(await world.secret());
        if (outcome.kind !== 'owner') throw new Error(outcome.kind);
        world.clock.advance(10 * 60_000);
        const auth = world.sessions.authenticate(outcome.token, CLIENT);
        if (auth.kind !== 'signed-in') throw new Error('not signed in');
        expect(auth.actor.stepUpFresh).toBe(false);
        const options = await world.gateway.stepUpOptions({ actor: auth.actor, rp: RP });
        expect(options).toMatchObject({ allowCredentials: ['credential-owner'] });
        const otherSession = { ...auth.actor, sessionId: 'session-other' as typeof auth.actor.sessionId };
        const response = world.ceremonies.assert(options, 'credential-owner', RP);
        expect(await world.gateway.stepUp({ actor: otherSession, response, rp: RP })).toBe(false);
        const fresh = await world.gateway.stepUpOptions({ actor: auth.actor, rp: RP });
        expect(
            await world.gateway.stepUp({
                actor: auth.actor,
                response: world.ceremonies.assert(fresh, 'credential-owner', RP),
                rp: RP,
            }),
        ).toBe(true);
        const after = world.sessions.authenticate(outcome.token, CLIENT);
        expect(after.kind === 'signed-in' && after.actor.stepUpFresh).toBe(true);
    });
});

describe('owner reset', () => {
    it('revokes every passkey and session, keeps the data, audits it and reopens setup', async () => {
        const world = await setup({ seeded: true });
        const before = world.runtime.controller().inspect();
        expect(before.passkeys.length).toBeGreaterThan(1);
        const token = world.sessions.signIn({
            memberId: before.members.find(({ role }) => role === 'owner')?.id ?? '',
            permissions: null,
            client: CLIENT,
        }).token;
        expect(await world.gateway.resetOwner()).toEqual({
            passkeys: before.passkeys.length,
            sessions: before.sessions.length + 1,
        });
        const after = world.runtime.controller().inspect();
        expect(after.passkeys).toEqual([]);
        expect(after.sessions).toEqual([]);
        expect(after.counts.agents).toBe(before.counts.agents);
        expect(after.members).toHaveLength(before.members.length);
        expect(membersWhoCanSignIn(after)).toBe(0);
        expect(world.sessions.authenticate(token, CLIENT).kind).toBe('invalid');
        expect(world.ownerChanges()).toBe(1);
        expect(world.logger.entries).toEqual([
            {
                level: 'warn',
                event: 'owner.reset',
                fields: { passkeys: before.passkeys.length, sessions: before.sessions.length + 1 },
            },
        ]);
        expect((await world.becomeOwner(await world.secret())).kind).toBe('owner');
    });

    it('drops the stored passkeys, so the old one no longer signs in', async () => {
        const world = await setup();
        await world.becomeOwner(await world.secret());
        await world.gateway.resetOwner();
        expect(await world.passkeys.list()).toEqual([]);
        expect(await world.signIn('credential-owner')).toEqual({ kind: 'not-recognised' });
    });
});

describe('restore', () => {
    it('puts the owner and their passkey back into a fresh engine state', async () => {
        const passkeys = createInMemoryPasskeyStore();
        const first = await setup({ passkeys });
        await first.becomeOwner(await first.secret());
        const second = await setup({ passkeys });
        await second.runtime.reset({ seed: 3, scenario: 'empty' });
        await second.gateway.restore();
        await second.gateway.restore();
        expect(second.ownerSetUp()).toBe(true);
        expect(second.runtime.controller().inspect().passkeys).toHaveLength(1);
        expect((await second.signIn('credential-owner')).kind).toBe('verified');
    });
});

describe('challenges', () => {
    function challenges(): { readonly store: Challenges; readonly clock: ReturnType<typeof createFakeClock> } {
        const clock = createFakeClock();
        return { store: createChallenges({ random: createSeededRandom(1), clock }), clock };
    }

    it('are single use, for one purpose and binding, and expire', () => {
        const { store, clock } = challenges();
        const challenge = store.issue('step-up', 'session-a');
        expect(store.take(challenge, 'step-up', 'session-b')).toBe(false);
        expect(store.take(challenge, 'step-up', 'session-a')).toBe(false);
        const next = store.issue('sign-in');
        expect(store.take(next, 'setup')).toBe(false);
        const third = store.issue('sign-in');
        expect(store.take(third, 'sign-in')).toBe(true);
        expect(store.take(third, 'sign-in')).toBe(false);
        const late = store.issue('setup');
        clock.advance(CHALLENGE_LIFETIME_MS);
        expect(store.take(late, 'setup')).toBe(false);
    });

    it('stay bounded under a flood of option requests', () => {
        const { store } = challenges();
        const first = store.issue('sign-in');
        for (let index = 0; index < MAX_PENDING_CHALLENGES; index++) store.issue('sign-in');
        expect(store.take(first, 'sign-in')).toBe(false);
        const last = store.issue('sign-in');
        expect(store.take(last, 'sign-in')).toBe(true);
    });
});
