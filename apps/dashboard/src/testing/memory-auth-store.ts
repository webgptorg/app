import type { AuthStore } from '../domain/auth/auth-store';
import type {
    AdminAuditEntry,
    ChallengeRecord,
    EmailTokenRecord,
    MembershipRecord,
    OrganizationRecord,
    PasskeyRecord,
    SessionRecord,
    UserRecord,
} from '../domain/auth/records';

export interface MemoryAuthState {
    readonly users: Map<string, UserRecord>;
    readonly orgs: Map<string, OrganizationRecord>;
    readonly memberships: MembershipRecord[];
    readonly passkeys: Map<string, PasskeyRecord>;
    readonly sessions: Map<string, SessionRecord>;
    readonly challenges: Map<string, ChallengeRecord>;
    readonly emailTokens: Map<string, EmailTokenRecord>;
    readonly adminAudit: AdminAuditEntry[];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * The {@link AuthStore} in memory, for tests: the same contract as the D1 adapter (the shared suite in
 * `auth-store-contract.ts` runs against both), including unique emails, credential IDs and user handles.
 */
export function createMemoryAuthStore(): AuthStore & { readonly state: MemoryAuthState } {
    const state: MemoryAuthState = {
        users: new Map(),
        orgs: new Map(),
        memberships: [],
        passkeys: new Map(),
        sessions: new Map(),
        challenges: new Map(),
        emailTokens: new Map(),
        adminAudit: [],
    };

    const membershipView = (membership: MembershipRecord) => {
        const org = state.orgs.get(membership.orgId);
        return org === undefined ? [] : [{ ...membership, org }];
    };
    const userConflicts = (user: UserRecord) =>
        state.users.has(user.id) ||
        [...state.users.values()].some(
            (other) => other.email === user.email || sameBytes(other.webauthnUserId, user.webauthnUserId),
        );
    const updateSession = (idHash: string, change: Partial<SessionRecord>) => {
        const session = state.sessions.get(idHash);
        if (session !== undefined) {
            state.sessions.set(idHash, { ...session, ...change });
        }
    };
    const updatePasskey = (userId: string, credentialId: string, change: Partial<PasskeyRecord>) => {
        const passkey = state.passkeys.get(credentialId);
        if (passkey?.userId === userId) {
            state.passkeys.set(credentialId, { ...passkey, ...change });
        }
    };
    const revokeAll = (userId: string, at: number) => {
        for (const session of state.sessions.values()) {
            if (session.userId === userId && session.revokedAt === null) {
                state.sessions.set(session.idHash, { ...session, revokedAt: at });
            }
        }
    };
    const usable = (tokenHash: string, purpose: string, now: number) => {
        const token = state.emailTokens.get(tokenHash);
        return token !== undefined && token.purpose === purpose && token.usedAt === null && token.expiresAt > now
            ? token
            : null;
    };

    return {
        state,
        accounts: {
            findUser: (userId) => Promise.resolve(state.users.get(userId) ?? null),
            findUserByEmail: (email) =>
                Promise.resolve([...state.users.values()].find((user) => user.email === email) ?? null),
            findMembership: (orgId, userId) =>
                Promise.resolve(
                    state.memberships
                        .filter((membership) => membership.orgId === orgId && membership.userId === userId)
                        .flatMap(membershipView)[0] ?? null,
                ),
            listMemberships: (userId) =>
                Promise.resolve(
                    state.memberships.filter((membership) => membership.userId === userId).flatMap(membershipView),
                ),
            createAccount(input) {
                if (
                    userConflicts(input.user) ||
                    state.orgs.has(input.org.id) ||
                    state.passkeys.has(input.passkey.credentialId) ||
                    state.sessions.has(input.session.idHash)
                ) {
                    return Promise.resolve('conflict');
                }
                state.users.set(input.user.id, input.user);
                state.orgs.set(input.org.id, input.org);
                state.memberships.push(input.membership);
                state.passkeys.set(input.passkey.credentialId, input.passkey);
                state.sessions.set(input.session.idHash, input.session);
                return Promise.resolve('created');
            },
            recoverAccount(input) {
                const user = state.users.get(input.userId);
                if (user === undefined || state.passkeys.has(input.passkey.credentialId)) {
                    return Promise.resolve('conflict');
                }
                state.passkeys.set(input.passkey.credentialId, input.passkey);
                revokeAll(input.userId, input.recoveredAt);
                state.users.set(user.id, { ...user, recoveredAt: input.recoveredAt });
                state.sessions.set(input.session.idHash, input.session);
                return Promise.resolve('recovered');
            },
        },
        passkeys: {
            find: (credentialId) => Promise.resolve(state.passkeys.get(credentialId) ?? null),
            listForUser: (userId) =>
                Promise.resolve(
                    [...state.passkeys.values()]
                        .filter((passkey) => passkey.userId === userId)
                        .sort((a, b) => a.createdAt - b.createdAt || a.credentialId.localeCompare(b.credentialId)),
                ),
            add(passkey) {
                if (state.passkeys.has(passkey.credentialId)) {
                    return Promise.resolve('conflict');
                }
                state.passkeys.set(passkey.credentialId, passkey);
                return Promise.resolve('added');
            },
            recordUse(userId, credentialId, counter, usedAt) {
                updatePasskey(userId, credentialId, { counter, lastUsedAt: usedAt });
                return Promise.resolve();
            },
            flagCounterRegression(userId, credentialId, at) {
                updatePasskey(userId, credentialId, { counterRegressedAt: at });
                return Promise.resolve();
            },
            deleteUnlessLast(userId, credentialId) {
                if (state.passkeys.get(credentialId)?.userId !== userId) {
                    return Promise.resolve('not-found');
                }
                const owned = [...state.passkeys.values()].filter((passkey) => passkey.userId === userId);
                if (owned.length <= 1) {
                    return Promise.resolve('last');
                }
                state.passkeys.delete(credentialId);
                return Promise.resolve('deleted');
            },
        },
        sessions: {
            create(session) {
                state.sessions.set(session.idHash, session);
                return Promise.resolve();
            },
            find: (idHash) => Promise.resolve(state.sessions.get(idHash) ?? null),
            touch(idHash, lastSeenAt) {
                updateSession(idHash, { lastSeenAt });
                return Promise.resolve();
            },
            markSteppedUp(idHash, at) {
                updateSession(idHash, { steppedUpAt: at });
                return Promise.resolve();
            },
            revoke(idHash, at) {
                if (state.sessions.get(idHash)?.revokedAt === null) {
                    updateSession(idHash, { revokedAt: at });
                }
                return Promise.resolve();
            },
            revokeAllForUser(userId, at) {
                revokeAll(userId, at);
                return Promise.resolve();
            },
            listActiveForUser: (userId, now) =>
                Promise.resolve(
                    [...state.sessions.values()]
                        .filter((s) => s.userId === userId && s.revokedAt === null && s.expiresAt > now)
                        .sort((a, b) => a.createdAt - b.createdAt),
                ),
        },
        challenges: {
            create(challenge, now) {
                for (const [id, existing] of state.challenges) {
                    if (existing.expiresAt <= now) {
                        state.challenges.delete(id);
                    }
                }
                state.challenges.set(challenge.id, challenge);
                return Promise.resolve();
            },
            consume(id, now) {
                const challenge = state.challenges.get(id);
                if (challenge === undefined || challenge.expiresAt <= now) {
                    return Promise.resolve(null);
                }
                state.challenges.delete(id);
                return Promise.resolve(challenge);
            },
        },
        emailTokens: {
            issue(token) {
                for (const [hash, existing] of state.emailTokens) {
                    const superseded = existing.email === token.email && existing.purpose === token.purpose;
                    if (superseded || existing.expiresAt <= token.createdAt) {
                        state.emailTokens.delete(hash);
                    }
                }
                state.emailTokens.set(token.tokenHash, token);
                return Promise.resolve();
            },
            findUsable: (tokenHash, purpose, now) => Promise.resolve(usable(tokenHash, purpose, now)),
            consume(tokenHash, purpose, now) {
                const token = usable(tokenHash, purpose, now);
                if (token === null) {
                    return Promise.resolve(null);
                }
                const used = { ...token, usedAt: now };
                state.emailTokens.set(tokenHash, used);
                return Promise.resolve(used);
            },
        },
        adminAudit: {
            append(entry) {
                state.adminAudit.push(entry);
                return Promise.resolve();
            },
        },
    };
}
