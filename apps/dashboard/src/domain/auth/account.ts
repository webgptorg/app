import type {
    AuthenticationOptions,
    AuthenticationResponse,
    RegistrationOptions,
    RegistrationResponse,
} from '../../shared/api/webauthn';
import type { Actor } from '../authz/authorizer';
import type { UserId } from '../ids';
import type { AuthDeps } from './auth-deps';
import { assertPasskey, consumeChallenge, issueChallenge } from './ceremony';
import type { MembershipView, PasskeyRecord, SessionRecord, UserRecord } from './records';
import { sha256Hex } from './secrets';
import { SESSION_IDLE_MS, SESSION_TOUCH_INTERVAL_MS } from './timing';

export interface ActiveSession {
    readonly record: SessionRecord;
    readonly user: UserRecord;
    readonly membership: MembershipView;
    readonly actor: Actor;
}

function isLive(session: SessionRecord, now: number): boolean {
    return session.revokedAt === null && now < session.expiresAt && now - session.lastSeenAt < SESSION_IDLE_MS;
}

/** Everything a signed-in person does to their own account: sessions, passkeys, step-up. */
export function createAccountFlows(deps: AuthDeps) {
    return {
        /** Reads the session row on every request, so a revocation takes effect on the very next one. */
        async resolveSession(token: string): Promise<ActiveSession | null> {
            const now = deps.clock.nowMs();
            const record = await deps.store.sessions.find(await sha256Hex(token));
            if (record === null || !isLive(record, now)) {
                return null;
            }
            const user = await deps.store.accounts.findUser(record.userId);
            const membership = await deps.store.accounts.findMembership(record.activeOrgId, record.userId);
            if (user === null || membership === null) {
                return null;
            }
            if (now - record.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
                await deps.store.sessions.touch(record.idHash, now);
            }
            return {
                record,
                user,
                membership,
                actor: {
                    userId: user.id,
                    orgId: membership.orgId,
                    orgRole: membership.role,
                    platformRole: user.platformRole,
                    recoveredAt: user.recoveredAt,
                    steppedUpAt: record.steppedUpAt,
                },
            };
        },

        listMemberships(userId: UserId): Promise<readonly MembershipView[]> {
            return deps.store.accounts.listMemberships(userId);
        },

        async listSessions(userId: UserId): Promise<readonly SessionRecord[]> {
            const now = deps.clock.nowMs();
            const sessions = await deps.store.sessions.listActiveForUser(userId, now);
            return sessions.filter((session) => isLive(session, now));
        },

        async signOut(session: SessionRecord): Promise<void> {
            await deps.store.sessions.revoke(session.idHash, deps.clock.nowMs());
        },

        async revokeAllSessions(userId: UserId): Promise<void> {
            await deps.store.sessions.revokeAllForUser(userId, deps.clock.nowMs());
        },

        listPasskeys(userId: UserId): Promise<readonly PasskeyRecord[]> {
            return deps.store.passkeys.listForUser(userId);
        },

        async addPasskeyOptions(
            user: UserRecord,
        ): Promise<{ readonly options: RegistrationOptions; readonly challengeId: string }> {
            const existing = await deps.store.passkeys.listForUser(user.id);
            const challenge = await issueChallenge(deps, { purpose: 'passkey-add', userId: user.id });
            const options = await deps.relyingParty.registrationOptions({
                challenge: challenge.challenge,
                userHandle: user.webauthnUserId,
                userName: user.email,
                exclude: existing.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
            });
            return { options, challengeId: challenge.id };
        },

        async addPasskey(input: {
            readonly userId: UserId;
            readonly challengeId: string | null;
            readonly response: RegistrationResponse;
        }): Promise<
            | { readonly kind: 'ok'; readonly passkey: PasskeyRecord }
            | { readonly kind: 'challenge-invalid' | 'webauthn-failed' | 'conflict' }
        > {
            const challenge = await consumeChallenge(deps, input.challengeId, {
                purpose: 'passkey-add',
                userId: input.userId,
            });
            if (challenge === null) {
                return { kind: 'challenge-invalid' };
            }
            const verification = await deps.relyingParty.verifyRegistration({
                response: input.response,
                expectedChallenge: challenge.challenge,
            });
            if (verification.kind === 'rejected') {
                return { kind: 'webauthn-failed' };
            }
            const { credential } = verification;
            const passkey: PasskeyRecord = {
                credentialId: credential.id,
                userId: input.userId,
                publicKey: credential.publicKey,
                counter: credential.counter,
                transports: credential.transports,
                backedUp: credential.backedUp,
                addedVia: 'account',
                createdAt: deps.clock.nowMs(),
                lastUsedAt: null,
                counterRegressedAt: null,
            };
            return (await deps.store.passkeys.add(passkey)) === 'added'
                ? { kind: 'ok', passkey }
                : { kind: 'conflict' };
        },

        deletePasskey(userId: UserId, credentialId: string): Promise<'deleted' | 'not-found' | 'last'> {
            return deps.store.passkeys.deleteUnlessLast(userId, credentialId);
        },

        async stepUpOptions(
            userId: UserId,
        ): Promise<{ readonly options: AuthenticationOptions; readonly challengeId: string }> {
            const passkeys = await deps.store.passkeys.listForUser(userId);
            const challenge = await issueChallenge(deps, { purpose: 'step-up', userId });
            const options = deps.relyingParty.authenticationOptions({
                challenge: challenge.challenge,
                allow: passkeys.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
            });
            return { options, challengeId: challenge.id };
        },

        async stepUp(input: {
            readonly session: SessionRecord;
            readonly challengeId: string | null;
            readonly response: AuthenticationResponse;
        }): Promise<
            | { readonly kind: 'ok'; readonly steppedUpAt: number }
            | { readonly kind: 'challenge-invalid' | 'webauthn-failed' }
        > {
            const { userId } = input.session;
            const challenge = await consumeChallenge(deps, input.challengeId, { purpose: 'step-up', userId });
            if (challenge === null) {
                return { kind: 'challenge-invalid' };
            }
            const asserted = await assertPasskey(deps, { response: input.response, challenge, owner: userId });
            if (asserted.kind === 'webauthn-failed') {
                return asserted;
            }
            const now = deps.clock.nowMs();
            await deps.store.sessions.markSteppedUp(input.session.idHash, now);
            return { kind: 'ok', steppedUpAt: now };
        },
    };
}
