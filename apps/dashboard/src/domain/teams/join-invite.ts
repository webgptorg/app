import type { AuthenticationResponse, RegistrationOptions, RegistrationResponse } from '../../shared/api/webauthn';
import type { AuthDeps } from '../auth/auth-deps';
import { assertPasskey, consumeChallenge, issueChallenge, newSession, type IssuedSession } from '../auth/ceremony';
import { sha256Hex } from '../auth/secrets';
import { newOrgAuditEntryId, newUserId, type OrgId, type TeamId } from '../ids';
import type { Locale } from '../locale';
import { acceptInvite } from './invites';
import type { InvitePreview, TeamStore } from './team-store';

export interface InviteJoinDeps extends AuthDeps {
    readonly teams: Pick<TeamStore, 'previewInvite' | 'acceptInvite' | 'acceptInviteAsNewUser'>;
}

/** Where an accepted invitation put the person; the SPA continues to the engines of these teams. */
export interface JoinedInvite {
    readonly orgId: OrgId;
    readonly teamIds: readonly TeamId[];
}

export type InviteJoinOutcome =
    | { readonly kind: 'ok'; readonly session: IssuedSession; readonly joined: JoinedInvite }
    | { readonly kind: 'challenge-invalid' | 'webauthn-failed' | 'invite-invalid' }
    /** The address has an account: it signs in and joins instead, so an invitation never makes a second account. */
    | { readonly kind: 'account-exists' }
    /** The passkey belongs to an account with another address: a forwarded link does not let someone else in. */
    | { readonly kind: 'email-mismatch' };

/**
 * Joining from the invitation page in one step (D-31). The invitation link proves the address the way a signup link
 * does: it was emailed there, works once and lapses after 7 days. So someone without an account registers a passkey
 * against the invitation, and the account, its passkey, the membership and a session are written in one transaction,
 * with no separate confirmation email. Someone with an account signs in with a passkey and accepts in the same request.
 */
export function createInviteJoinFlow(deps: InviteJoinDeps) {
    async function pending(
        token: string,
    ): Promise<{ readonly tokenHash: string; readonly preview: InvitePreview } | null> {
        const tokenHash = await sha256Hex(token);
        const preview = await deps.teams.previewInvite(tokenHash, deps.clock.nowMs());
        return preview === null ? null : { tokenHash, preview };
    }

    return {
        /** The invitation's names, and whether its address has an account: only the link's holder learns that. */
        async preview(
            token: string,
        ): Promise<{ readonly preview: InvitePreview; readonly hasAccount: boolean } | null> {
            const found = await pending(token);
            if (found === null) {
                return null;
            }
            const user = await deps.store.accounts.findUserByEmail(found.preview.invite.email);
            return { preview: found.preview, hasAccount: user !== null };
        },

        async joinOptions(input: {
            readonly token: string;
        }): Promise<
            | { readonly kind: 'ok'; readonly options: RegistrationOptions; readonly challengeId: string }
            | { readonly kind: 'invite-invalid' | 'account-exists' }
        > {
            const found = await pending(input.token);
            if (found === null) {
                return { kind: 'invite-invalid' };
            }
            const { email } = found.preview.invite;
            if ((await deps.store.accounts.findUserByEmail(email)) !== null) {
                return { kind: 'account-exists' };
            }
            const userHandle = deps.random.bytes(32);
            const challenge = await issueChallenge(deps, {
                purpose: 'invite',
                tokenHash: found.tokenHash,
                webauthnUserId: userHandle,
            });
            const options = await deps.relyingParty.registrationOptions({
                challenge: challenge.challenge,
                userHandle,
                userName: email,
                exclude: [],
            });
            return { kind: 'ok', options, challengeId: challenge.id };
        },

        async joinVerify(input: {
            readonly token: string;
            readonly challengeId: string | null;
            readonly response: RegistrationResponse;
            readonly locale: Locale;
        }): Promise<Exclude<InviteJoinOutcome, { readonly kind: 'email-mismatch' }>> {
            const tokenHash = await sha256Hex(input.token);
            const challenge = await consumeChallenge(deps, input.challengeId, { purpose: 'invite', tokenHash });
            if (challenge?.webauthnUserId == null) {
                return { kind: 'challenge-invalid' };
            }
            const verification = await deps.relyingParty.verifyRegistration({
                response: input.response,
                expectedChallenge: challenge.challenge,
            });
            if (verification.kind === 'rejected') {
                return { kind: 'webauthn-failed' };
            }
            const found = await pending(input.token);
            if (found === null) {
                return { kind: 'invite-invalid' };
            }
            const { invite } = found.preview;
            if ((await deps.store.accounts.findUserByEmail(invite.email)) !== null) {
                return { kind: 'account-exists' };
            }
            const now = deps.clock.nowMs();
            const userId = newUserId(deps.random);
            const session = await newSession(deps, { userId, orgId: invite.orgId, steppedUp: false });
            const { credential } = verification;
            const outcome = await deps.teams.acceptInviteAsNewUser(
                tokenHash,
                {
                    user: {
                        id: userId,
                        // The invitation link was emailed to this address and just used: that is the proof.
                        emailVerifiedAt: now,
                        locale: input.locale,
                        platformRole: 'none',
                        recoveredAt: null,
                        createdAt: now,
                        webauthnUserId: challenge.webauthnUserId,
                    },
                    passkey: {
                        credentialId: credential.id,
                        userId,
                        publicKey: credential.publicKey,
                        counter: credential.counter,
                        transports: credential.transports,
                        backedUp: credential.backedUp,
                        aaguid: credential.aaguid,
                        addedVia: 'signup',
                        createdAt: now,
                        lastUsedAt: now,
                        counterRegressedAt: null,
                    },
                    session: session.record,
                },
                { id: newOrgAuditEntryId(deps.random), at: now },
            );
            switch (outcome.kind) {
                case 'accepted':
                    deps.logger.info('invites.joined', { as: 'new-account' });
                    return { kind: 'ok', session, joined: { orgId: outcome.orgId, teamIds: invite.teamIds } };
                case 'invalid':
                    return { kind: 'invite-invalid' };
                case 'conflict':
                    return { kind: 'account-exists' };
            }
        },

        /** Verifies a sign-in assertion (from the usual sign-in options), then accepts for that account. */
        async signInAndAccept(input: {
            readonly token: string;
            readonly challengeId: string | null;
            readonly response: AuthenticationResponse;
            /** The cookie of a session this browser already had; it is revoked, never reused. */
            readonly previousSessionToken: string | null;
        }): Promise<Exclude<InviteJoinOutcome, { readonly kind: 'account-exists' }>> {
            const challenge = await consumeChallenge(deps, input.challengeId, { purpose: 'signin' });
            if (challenge === null) {
                return { kind: 'challenge-invalid' };
            }
            const asserted = await assertPasskey(deps, { response: input.response, challenge, owner: 'any' });
            if (asserted.kind === 'webauthn-failed') {
                return asserted;
            }
            const found = await pending(input.token);
            const accepted = await acceptInvite(
                deps,
                { userId: asserted.user.id, email: asserted.user.email },
                input.token,
            );
            if (found === null || accepted.kind === 'invalid') {
                return { kind: 'invite-invalid' };
            }
            if (accepted.kind === 'email-mismatch') {
                return accepted;
            }
            if (input.previousSessionToken !== null) {
                await deps.store.sessions.revoke(await sha256Hex(input.previousSessionToken), deps.clock.nowMs());
            }
            // The assertion just now was user-verified, so it counts as a fresh step-up, as in any sign-in.
            const session = await newSession(deps, {
                userId: asserted.user.id,
                orgId: accepted.orgId,
                steppedUp: true,
            });
            await deps.store.sessions.create(session.record);
            deps.logger.info('invites.joined', { as: 'existing-account' });
            return {
                kind: 'ok',
                session,
                joined: { orgId: accepted.orgId, teamIds: found.preview.invite.teamIds },
            };
        },
    };
}
