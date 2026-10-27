import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { createSeededRandom } from '../../testing/seeded-random';
import {
    SETUP_SECRET_LIFETIME_MS,
    SETUP_SECRET_PATTERN,
    createInMemorySetupSecretStore,
    createSetupSecrets,
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
        expect(await secrets.consume(secret)).toBe('valid');
        expect(await secrets.consume(secret)).toBe('invalid');
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
        expect(await secrets.consume(secret)).toBe('invalid');
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
        expect(await secrets.consume(secret)).toBe('owner-exists');
        expect(await secrets.issue()).toEqual({ kind: 'owner-exists' });
    });

    it('lets only one of two racing setups spend it', async () => {
        const { secrets, issue } = setup();
        const secret = await issue();
        const results = await Promise.all([secrets.consume(secret), secrets.consume(secret), secrets.consume(secret)]);
        expect(results.filter((result) => result === 'valid')).toHaveLength(1);
    });

    it('can be revoked', async () => {
        const { store, secrets, issue } = setup();
        const secret = await issue();
        await secrets.revoke();
        expect(store.current()).toBeNull();
        expect(await secrets.check(secret)).toBe('invalid');
    });
});
