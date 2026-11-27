import {
    OWNER_HANDOFF_LIFETIME_MS,
    newOwnerSetupSecret,
    ownerSetupCommitment,
    ownerSetupCommitmentDigest,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { createSeededRandom } from '../../testing/seeded-random';
import {
    SETUP_SECRET_LIFETIME_MS,
    SETUP_SECRET_PATTERN,
    createInMemorySetupSecretStore,
    createSetupSecrets,
    handoffSlot,
} from './setup-secret';

function setup() {
    const clock = createFakeClock(Date.parse('2026-10-26T10:00:00Z'));
    const store = createInMemorySetupSecretStore();
    const owner = { set: false };
    const secrets = createSetupSecrets({ store, random: createSeededRandom(9), clock, hasOwner: () => owner.set });
    async function issue(): Promise<string> {
        const issued = await secrets.issue();
        if (issued.kind !== 'issued') throw new Error('not issued');
        return issued.secret.reveal();
    }
    return { clock, store, owner, secrets, issue };
}

describe('setup secret', () => {
    it('is 128 bits of base64url, valid for 30 minutes, and kept only as its SHA-256', async () => {
        const { clock, store, secrets } = setup();
        const issued = await secrets.issue();
        if (issued.kind !== 'issued') throw new Error('not issued');
        const value = issued.secret.reveal();
        expect(value).toMatch(SETUP_SECRET_PATTERN);
        expect(issued.expiresAtMs).toBe(clock.nowMs() + SETUP_SECRET_LIFETIME_MS);
        expect(JSON.stringify(issued)).not.toContain(value);
        expect(JSON.stringify({ secret: issued.secret })).toBe('{"secret":"[redacted]"}');
        const stored = store.current();
        expect(stored?.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(stored)).not.toContain(value);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
        expect(stored?.sha256).toBe(Buffer.from(digest).toString('hex'));
    });

    it('checks without spending, and works exactly once', async () => {
        const { secrets, issue } = setup();
        const secret = await issue();
        expect(await secrets.check(secret)).toBe('valid');
        expect(await secrets.check(secret)).toBe('valid');
        expect(await secrets.consume(secret)).toEqual({ kind: 'valid', slot: 'setup-link' });
        expect(await secrets.consume(secret)).toEqual({ kind: 'invalid' });
        expect(await secrets.check(secret)).toBe('invalid');
    });

    it('expires after 30 minutes, with the same answer as a wrong or malformed secret', async () => {
        const { clock, secrets, issue } = setup();
        const secret = await issue();
        clock.advance(SETUP_SECRET_LIFETIME_MS - 1);
        expect(await secrets.check(secret)).toBe('valid');
        clock.advance(1);
        const answers = await Promise.all([
            secrets.check(secret),
            secrets.check('A'.repeat(22)),
            secrets.check('not a secret'),
            secrets.check(''),
        ]);
        expect(new Set(answers)).toEqual(new Set(['invalid']));
        expect(await secrets.consume(secret)).toEqual({ kind: 'invalid' });
    });

    it('is replaced by every new link, so an old copy stops working', async () => {
        const { secrets, issue } = setup();
        const first = await issue();
        const second = await issue();
        expect(second).not.toBe(first);
        expect(await secrets.check(first)).toBe('invalid');
        expect(await secrets.check(second)).toBe('valid');
    });

    it('is refused for good once the engine has an owner, and not issued then', async () => {
        const { owner, secrets, issue } = setup();
        const secret = await issue();
        owner.set = true;
        expect(await secrets.check(secret)).toBe('owner-exists');
        expect(await secrets.consume(secret)).toEqual({ kind: 'owner-exists' });
        expect(await secrets.issue()).toEqual({ kind: 'owner-exists' });
    });

    it('lets only one of two racing setups spend it', async () => {
        const { secrets, issue } = setup();
        const secret = await issue();
        const results = await Promise.all([secrets.consume(secret), secrets.consume(secret), secrets.consume(secret)]);
        expect(results.filter((result) => result.kind === 'valid')).toHaveLength(1);
    });

    it('can be revoked', async () => {
        const { store, secrets, issue } = setup();
        const secret = await issue();
        await secrets.revoke();
        expect(store.current()).toBeNull();
        expect(await secrets.check(secret)).toBe('invalid');
    });
});

describe('owner setup handoff slot (ADR 0023)', () => {
    async function withHandoff(options: { readonly on?: boolean } = {}) {
        const base = setup();
        const handoffStore = createInMemorySetupSecretStore();
        const secrets = createSetupSecrets({
            store: base.store,
            random: createSeededRandom(9),
            clock: base.clock,
            hasOwner: () => base.owner.set,
            ...(options.on === false ? {} : { handoff: handoffStore }),
        });
        const tab = newOwnerSetupSecret(createSeededRandom(3));
        const commitment = await ownerSetupCommitment(tab);
        return { ...base, secrets, handoffStore, tab, commitment };
    }

    it('keeps only the commitment as a second slot for 30 minutes from registration', async () => {
        const { clock, secrets, handoffStore, tab, commitment } = await withHandoff();
        const registeredAtMs = clock.nowMs() - 1000;
        expect(await secrets.acceptHandoff(commitment, registeredAtMs)).toBe('accepted');
        expect(handoffStore.current()).toEqual({
            sha256: Buffer.from(ownerSetupCommitmentDigest(commitment)).toString('hex'),
            expiresAtMs: registeredAtMs + OWNER_HANDOFF_LIFETIME_MS,
        });
        expect(JSON.stringify(handoffStore.current())).not.toContain(tab);
        expect(secrets.handoffLive()).toBe(true);
        expect(await secrets.check(tab)).toBe('valid');
        clock.advance(OWNER_HANDOFF_LIFETIME_MS - 1001);
        expect(await secrets.check(tab)).toBe('valid');
        clock.advance(1);
        expect(secrets.handoffLive()).toBe(false);
        expect(await secrets.check(tab)).toBe('invalid');
        expect(await secrets.consume(tab)).toEqual({ kind: 'invalid' });
    });

    it('answers a wrong secret and the commitment itself like any wrong setup secret', async () => {
        const { clock, secrets, commitment } = await withHandoff();
        await secrets.acceptHandoff(commitment, clock.nowMs());
        expect(await secrets.check(newOwnerSetupSecret(createSeededRandom(4)))).toBe('invalid');
        expect(await secrets.check(commitment)).toBe('invalid');
    });

    it('spends both slots with the first owner, whichever secret set it up', async () => {
        for (const via of ['setup-link', 'owner-handoff'] as const) {
            const { clock, store, secrets, handoffStore, tab, commitment, issue } = await withHandoff();
            await secrets.acceptHandoff(commitment, clock.nowMs());
            const own = await issue();
            expect(await secrets.consume(via === 'setup-link' ? own : tab)).toEqual({ kind: 'valid', slot: via });
            expect(store.current()).toBeNull();
            expect(handoffStore.current()).toBeNull();
            expect(secrets.handoffLive()).toBe(false);
            expect(await secrets.check(via === 'setup-link' ? tab : own)).toBe('invalid');
        }
    });

    it('is ignored by an engine that has an owner, and dead once one appears', async () => {
        const { clock, owner, secrets, handoffStore, tab, commitment } = await withHandoff();
        owner.set = true;
        expect(await secrets.acceptHandoff(commitment, clock.nowMs())).toBe('owner-exists');
        expect(handoffStore.current()).toBeNull();
        owner.set = false;
        await secrets.acceptHandoff(commitment, clock.nowMs());
        owner.set = true;
        expect(secrets.handoffLive()).toBe(false);
        expect(await secrets.check(tab)).toBe('owner-exists');
        await secrets.loadHandoff();
        expect(handoffStore.current()).toBeNull();
    });

    it('is ignored with handoff off', async () => {
        const { clock, secrets, tab, commitment } = await withHandoff({ on: false });
        expect(await secrets.acceptHandoff(commitment, clock.nowMs())).toBe('off');
        expect(secrets.handoffLive()).toBe(false);
        expect(await secrets.check(tab)).toBe('invalid');
        await secrets.loadHandoff();
        expect(secrets.handoffLive()).toBe(false);
    });

    it('survives a new setup link, but not owner --reset', async () => {
        const { clock, secrets, handoffStore, tab, commitment, issue } = await withHandoff();
        await secrets.acceptHandoff(commitment, clock.nowMs());
        await issue();
        expect(await secrets.check(tab)).toBe('valid');
        await secrets.revoke();
        expect(handoffStore.current()).toBeNull();
        expect(await secrets.check(tab)).toBe('invalid');
    });

    it('picks up a slot another process stored', async () => {
        const { clock, secrets, handoffStore, tab, commitment } = await withHandoff();
        await handoffStore.save(handoffSlot(commitment, clock.nowMs()));
        expect(secrets.handoffLive()).toBe(false);
        await secrets.loadHandoff();
        expect(secrets.handoffLive()).toBe(true);
        expect(await secrets.check(tab)).toBe('valid');
    });
});
