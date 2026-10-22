import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthStore } from '../domain/auth/auth-store';
import type { PasskeyRecord, SessionRecord, UserRecord } from '../domain/auth/records';
import { newOrgId, newUserId, type OrgId, type UserId } from '../domain/ids';
import { cryptoRandom } from '../adapters/crypto-random';

const NOW = 1_800_000_000_000;

function bytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
}

function randomId(): string {
    return crypto.randomUUID().replace(/-/g, '');
}

/** A complete, valid signup: user, personal org, owner membership, passkey and session. */
export function testAccount(email = `${randomId()}@example.test`) {
    const userId = newUserId(cryptoRandom);
    const orgId = newOrgId(cryptoRandom);
    const user: UserRecord = {
        id: userId,
        email,
        emailVerifiedAt: NOW,
        locale: 'cs',
        platformRole: 'none',
        recoveredAt: null,
        createdAt: NOW,
        webauthnUserId: bytes(32),
    };
    return {
        userId,
        orgId,
        user,
        org: { id: orgId, kind: 'personal', name: null, createdAt: NOW } as const,
        membership: { orgId, userId, role: 'owner', createdAt: NOW } as const,
        passkey: passkey(userId),
        session: session(userId, orgId),
    };
}

function passkey(userId: UserId, createdAt = NOW): PasskeyRecord {
    return {
        credentialId: randomId(),
        userId,
        publicKey: bytes(77),
        counter: 0,
        transports: ['internal', 'hybrid'],
        backedUp: true,
        addedVia: 'signup',
        createdAt,
        lastUsedAt: null,
        counterRegressedAt: null,
    };
}

function session(userId: UserId, orgId: OrgId, createdAt = NOW): SessionRecord {
    return {
        idHash: randomId(),
        userId,
        activeOrgId: orgId,
        createdAt,
        lastSeenAt: createdAt,
        expiresAt: createdAt + 1000,
        steppedUpAt: null,
        revokedAt: null,
    };
}

/** The {@link AuthStore} contract, run against every adapter (ADR 0009: D1; tests: memory). */
export function describeAuthStoreContract(name: string, makeStore: () => AuthStore): void {
    describe(`AuthStore contract: ${name}`, () => {
        let store: AuthStore;

        beforeEach(() => {
            store = makeStore();
        });

        it('creates an account atomically and reads it back byte for byte', async () => {
            const a = testAccount();
            expect(await store.accounts.createAccount(a)).toBe('created');
            const user = await store.accounts.findUser(a.userId);
            expect(user).toEqual(a.user);
            expect(user?.webauthnUserId).toBeInstanceOf(Uint8Array);
            expect(await store.accounts.findUserByEmail(a.user.email)).toEqual(a.user);
            expect(await store.passkeys.find(a.passkey.credentialId)).toEqual(a.passkey);
            expect(await store.sessions.find(a.session.idHash)).toEqual(a.session);
            expect(await store.accounts.listMemberships(a.userId)).toEqual([{ ...a.membership, org: a.org }]);
        });

        it('refuses a second account with the same email, user handle or credential, writing nothing', async () => {
            const a = testAccount();
            await store.accounts.createAccount(a);
            const sameEmail = testAccount(a.user.email);
            expect(await store.accounts.createAccount(sameEmail)).toBe('conflict');
            expect(await store.accounts.findUser(sameEmail.userId)).toBeNull();
            expect(await store.accounts.listMemberships(sameEmail.userId)).toEqual([]);
            const sameHandle = testAccount();
            expect(
                await store.accounts.createAccount({
                    ...sameHandle,
                    user: { ...sameHandle.user, webauthnUserId: a.user.webauthnUserId },
                }),
            ).toBe('conflict');
            const sameCredential = testAccount();
            expect(
                await store.accounts.createAccount({
                    ...sameCredential,
                    passkey: { ...sameCredential.passkey, credentialId: a.passkey.credentialId },
                }),
            ).toBe('conflict');
            expect(await store.accounts.findUser(sameCredential.userId)).toBeNull();
        });

        it('org B cannot read or change org A’s rows', async () => {
            const a = testAccount();
            const b = testAccount();
            await store.accounts.createAccount(a);
            await store.accounts.createAccount(b);
            expect(await store.accounts.findMembership(a.orgId, b.userId)).toBeNull();
            expect(await store.accounts.findMembership(b.orgId, a.userId)).toBeNull();
            expect((await store.accounts.findMembership(a.orgId, a.userId))?.org.id).toBe(a.orgId);
            expect((await store.accounts.listMemberships(b.userId)).map((m) => m.orgId)).toEqual([b.orgId]);

            expect(await store.passkeys.deleteUnlessLast(b.userId, a.passkey.credentialId)).toBe('not-found');
            await store.passkeys.recordUse(b.userId, a.passkey.credentialId, 99, NOW + 1);
            await store.passkeys.flagCounterRegression(b.userId, a.passkey.credentialId, NOW + 1);
            expect(await store.passkeys.find(a.passkey.credentialId)).toEqual(a.passkey);
            expect(await store.passkeys.listForUser(b.userId)).toEqual([b.passkey]);

            await store.sessions.revokeAllForUser(b.userId, NOW + 1);
            expect((await store.sessions.find(a.session.idHash))?.revokedAt).toBeNull();
            expect(await store.sessions.listActiveForUser(b.userId, NOW)).toEqual([]);
            expect(await store.sessions.listActiveForUser(a.userId, NOW)).toEqual([a.session]);
        });

        it('records passkey use and counter regressions for the owner', async () => {
            const a = testAccount();
            await store.accounts.createAccount(a);
            await store.passkeys.recordUse(a.userId, a.passkey.credentialId, 7, NOW + 5);
            await store.passkeys.flagCounterRegression(a.userId, a.passkey.credentialId, NOW + 6);
            expect(await store.passkeys.find(a.passkey.credentialId)).toMatchObject({
                counter: 7,
                lastUsedAt: NOW + 5,
                counterRegressedAt: NOW + 6,
            });
        });

        it('adds passkeys, lists them oldest first, refuses a duplicate, and never deletes the last one', async () => {
            const a = testAccount();
            await store.accounts.createAccount(a);
            const second = { ...passkey(a.userId, NOW + 1), addedVia: 'account' as const };
            expect(await store.passkeys.add(second)).toBe('added');
            expect(await store.passkeys.add(second)).toBe('conflict');
            expect(await store.passkeys.listForUser(a.userId)).toEqual([a.passkey, second]);
            const [first, again] = await Promise.all([
                store.passkeys.deleteUnlessLast(a.userId, a.passkey.credentialId),
                store.passkeys.deleteUnlessLast(a.userId, second.credentialId),
            ]);
            expect([first, again].sort()).toEqual(['deleted', 'last']);
            expect(await store.passkeys.listForUser(a.userId)).toHaveLength(1);
            expect(await store.passkeys.deleteUnlessLast(a.userId, randomId())).toBe('not-found');
        });

        it('creates, touches, steps up and revokes sessions', async () => {
            const a = testAccount();
            await store.accounts.createAccount(a);
            const second = session(a.userId, a.orgId, NOW + 1);
            await store.sessions.create(second);
            await store.sessions.touch(second.idHash, NOW + 2);
            await store.sessions.markSteppedUp(second.idHash, NOW + 3);
            expect(await store.sessions.find(second.idHash)).toMatchObject({
                lastSeenAt: NOW + 2,
                steppedUpAt: NOW + 3,
            });
            expect(await store.sessions.listActiveForUser(a.userId, NOW + 1)).toHaveLength(2);
            expect(await store.sessions.listActiveForUser(a.userId, NOW + 1000)).toHaveLength(1);
            await store.sessions.revoke(second.idHash, NOW + 4);
            await store.sessions.revoke(second.idHash, NOW + 5);
            expect((await store.sessions.find(second.idHash))?.revokedAt).toBe(NOW + 4);
            await store.sessions.revokeAllForUser(a.userId, NOW + 6);
            expect((await store.sessions.find(a.session.idHash))?.revokedAt).toBe(NOW + 6);
            expect((await store.sessions.find(second.idHash))?.revokedAt).toBe(NOW + 4);
            expect(await store.sessions.find(randomId())).toBeNull();
        });

        it('moves a session only to an organization its user is a member of', async () => {
            const a = testAccount();
            const b = testAccount();
            await store.accounts.createAccount(a);
            await store.accounts.createAccount(b);
            expect(await store.sessions.setActiveOrg(a.session.idHash, a.orgId)).toBe('switched');
            expect(await store.sessions.setActiveOrg(a.session.idHash, b.orgId)).toBe('not-member');
            expect(await store.sessions.find(a.session.idHash)).toEqual(a.session);
            expect(await store.sessions.setActiveOrg(randomId(), a.orgId)).toBe('not-member');
            await store.sessions.revoke(a.session.idHash, NOW + 1);
            expect(await store.sessions.setActiveOrg(a.session.idHash, a.orgId)).toBe('not-member');
        });

        it('recovers an account: new passkey, every session revoked, recovered_at set, a new session', async () => {
            const a = testAccount();
            await store.accounts.createAccount(a);
            const recoveryPasskey = { ...passkey(a.userId, NOW + 10), addedVia: 'recovery' as const };
            const fresh = session(a.userId, a.orgId, NOW + 10);
            expect(
                await store.accounts.recoverAccount({
                    userId: a.userId,
                    passkey: recoveryPasskey,
                    session: fresh,
                    recoveredAt: NOW + 10,
                }),
            ).toBe('recovered');
            expect((await store.accounts.findUser(a.userId))?.recoveredAt).toBe(NOW + 10);
            expect((await store.sessions.find(a.session.idHash))?.revokedAt).toBe(NOW + 10);
            expect((await store.sessions.find(fresh.idHash))?.revokedAt).toBeNull();
            expect((await store.passkeys.listForUser(a.userId)).map((p) => p.addedVia)).toEqual(['signup', 'recovery']);
            expect(
                await store.accounts.recoverAccount({
                    userId: a.userId,
                    passkey: recoveryPasskey,
                    session: session(a.userId, a.orgId),
                    recoveredAt: NOW + 11,
                }),
            ).toBe('conflict');
            expect((await store.accounts.findUser(a.userId))?.recoveredAt).toBe(NOW + 10);
        });

        it('consumes a challenge once, never after it expired, and drops expired ones on create', async () => {
            const challenge = {
                id: randomId(),
                challenge: randomId(),
                purpose: 'signup' as const,
                userId: null,
                tokenHash: randomId(),
                webauthnUserId: bytes(32),
                expiresAt: NOW + 100,
            };
            await store.challenges.create(challenge, NOW);
            const [first, second] = await Promise.all([
                store.challenges.consume(challenge.id, NOW),
                store.challenges.consume(challenge.id, NOW),
            ]);
            expect([first, second].filter((c) => c !== null)).toEqual([challenge]);

            const expiring = { ...challenge, id: randomId(), purpose: 'signin' as const, webauthnUserId: null };
            await store.challenges.create(expiring, NOW);
            expect(await store.challenges.consume(expiring.id, NOW + 100)).toBeNull();
            const later = { ...expiring, id: randomId(), expiresAt: NOW + 300 };
            await store.challenges.create(later, NOW + 200);
            expect(await store.challenges.consume(expiring.id, NOW)).toBeNull();
            expect(await store.challenges.consume(later.id, NOW + 200)).toEqual(later);
        });

        it('issues email tokens that supersede older ones for the same address and purpose', async () => {
            const email = `${randomId()}@example.test`;
            const token = (purpose: 'signup' | 'recovery', createdAt: number) => ({
                tokenHash: randomId(),
                purpose,
                email,
                userId: null,
                createdAt,
                expiresAt: createdAt + 100,
                usedAt: null,
            });
            const signupOld = token('signup', NOW);
            const recovery = token('recovery', NOW);
            await store.emailTokens.issue(signupOld);
            await store.emailTokens.issue(recovery);
            const signupNew = token('signup', NOW + 1);
            await store.emailTokens.issue(signupNew);
            expect(await store.emailTokens.findUsable(signupOld.tokenHash, 'signup', NOW + 1)).toBeNull();
            expect(await store.emailTokens.findUsable(recovery.tokenHash, 'recovery', NOW + 1)).toEqual(recovery);
            expect(await store.emailTokens.findUsable(signupNew.tokenHash, 'recovery', NOW + 1)).toBeNull();
            expect(await store.emailTokens.findUsable(signupNew.tokenHash, 'signup', NOW + 101)).toBeNull();

            const [first, second] = await Promise.all([
                store.emailTokens.consume(signupNew.tokenHash, 'signup', NOW + 2),
                store.emailTokens.consume(signupNew.tokenHash, 'signup', NOW + 2),
            ]);
            expect([first, second].filter((t) => t !== null)).toEqual([{ ...signupNew, usedAt: NOW + 2 }]);
            expect(await store.emailTokens.findUsable(signupNew.tokenHash, 'signup', NOW + 2)).toBeNull();
            expect(await store.emailTokens.consume(recovery.tokenHash, 'signup', NOW + 2)).toBeNull();
            expect(await store.emailTokens.consume(recovery.tokenHash, 'recovery', NOW + 100)).toBeNull();

            // Expired tokens of any address are dropped when the next one is issued.
            const other = { ...token('signup', NOW + 500), email: `${randomId()}@example.test` };
            await store.emailTokens.issue(other);
            expect(await store.emailTokens.findUsable(recovery.tokenHash, 'recovery', NOW)).toBeNull();
        });

        it('appends to the admin audit log', async () => {
            const a = testAccount();
            await store.accounts.createAccount(a);
            await expect(
                store.adminAudit.append({
                    id: randomId(),
                    adminUserId: a.userId,
                    action: 'admin.engine.suspend',
                    targetType: 'engine',
                    targetId: randomId(),
                    reason: null,
                    createdAt: NOW,
                }),
            ).resolves.toBeUndefined();
        });
    });
}
