import type { RegistrationResponse } from '../../shared/api/webauthn';
import { RECOVERY_COOLDOWN_MS } from '../authz/authorizer';
import type { AuthDeps } from './auth-deps';
import { consumeChallenge, issueChallenge, newSession, runInBackground, withinLimit } from './ceremony';
import type { EmailAddress } from './email-address';
import { newSecret, sha256Hex } from './secrets';
import type { DeferredDelivery, RegistrationOutcome, TokenOptionsOutcome } from './signup';
import type { IssuedSession } from './ceremony';
import { EMAIL_TOKEN_TTL_MS } from './timing';

export type RecoveryOutcome =
    /** `deliver` sends the recovery notice; run it after the response. */
    | { readonly kind: 'ok'; readonly session: IssuedSession; readonly deliver: () => Promise<void> }
    | Exclude<RegistrationOutcome, { readonly kind: 'ok' }>;

/** Where a recovery request came from; `invite` is the invitation page's "Email me a link" (D-35). */
export interface RecoveryContext {
    readonly kind: 'invite';
}

export interface RecoveryDeps extends AuthDeps {
    /** Pending invitations to an address, newest first; only these may name an organization in the email. */
    readonly teams: {
        listInvitesForEmail(email: string, now: number): Promise<readonly { readonly orgName: string | null }[]>;
    };
}

/**
 * Account recovery: an emailed link that only lets the person register a new passkey. Every other session ends, the
 * account enters the 72-hour cooldown for sensitive actions, and a notice goes to the same address.
 */
export function createRecoveryFlow(deps: RecoveryDeps) {
    async function deliver(email: EmailAddress, context: RecoveryContext | null, signal: AbortSignal): Promise<void> {
        if (!(await withinLimit(deps, 'recovery-request-email', email, signal))) {
            return;
        }
        const user = await deps.store.accounts.findUserByEmail(email);
        if (user === null) {
            return;
        }
        const token = newSecret(deps.random);
        const now = deps.clock.nowMs();
        await deps.store.emailTokens.issue({
            tokenHash: await sha256Hex(token),
            purpose: 'recovery',
            email,
            userId: user.id,
            createdAt: now,
            expiresAt: now + EMAIL_TOKEN_TTL_MS,
            usedAt: null,
        });
        // Without a real pending invitation the context is ignored: the client never names the organization.
        const [invite] = context === null ? [] : await deps.teams.listInvitesForEmail(email, now);
        await deps.email.send(
            invite === undefined
                ? { template: 'recovery-link', to: email, locale: user.locale, link: deps.links.recovery(token) }
                : {
                      template: 'invite-passkey-link',
                      to: email,
                      locale: user.locale,
                      orgName: invite.orgName,
                      link: deps.links.recovery(token, 'invite'),
                  },
            signal,
        );
    }

    async function tokenUser(tokenHash: string, consume: boolean) {
        const now = deps.clock.nowMs();
        const token = consume
            ? await deps.store.emailTokens.consume(tokenHash, 'recovery', now)
            : await deps.store.emailTokens.findUsable(tokenHash, 'recovery', now);
        const user = token === null ? null : await deps.store.accounts.findUserByEmail(token.email);
        return user !== null && user.id === token?.userId ? user : null;
    }

    return {
        request(input: { readonly email: EmailAddress; readonly context: RecoveryContext | null }): DeferredDelivery {
            return () => runInBackground(deps, 'recovery', (signal) => deliver(input.email, input.context, signal));
        },

        async options(input: { readonly token: string }): Promise<TokenOptionsOutcome> {
            const tokenHash = await sha256Hex(input.token);
            const user = await tokenUser(tokenHash, false);
            if (user === null) {
                return { kind: 'token-invalid' };
            }
            const existing = await deps.store.passkeys.listForUser(user.id);
            const challenge = await issueChallenge(deps, { purpose: 'recovery', userId: user.id, tokenHash });
            const options = await deps.relyingParty.registrationOptions({
                challenge: challenge.challenge,
                userHandle: user.webauthnUserId,
                userName: user.email,
                exclude: existing.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
            });
            return { kind: 'ok', options, challengeId: challenge.id };
        },

        async verify(input: {
            readonly token: string;
            readonly challengeId: string | null;
            readonly response: RegistrationResponse;
        }): Promise<RecoveryOutcome> {
            const tokenHash = await sha256Hex(input.token);
            const challenge = await consumeChallenge(deps, input.challengeId, { purpose: 'recovery', tokenHash });
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
            const user = await tokenUser(tokenHash, true);
            if (user === null || user.id !== challenge.userId) {
                return { kind: 'token-invalid' };
            }
            const memberships = await deps.store.accounts.listMemberships(user.id);
            const membership = memberships[0];
            if (membership === undefined) {
                return { kind: 'conflict' };
            }
            const now = deps.clock.nowMs();
            const session = await newSession(deps, { userId: user.id, orgId: membership.orgId, steppedUp: false });
            const { credential } = verification;
            const recovered = await deps.store.accounts.recoverAccount({
                userId: user.id,
                recoveredAt: now,
                session: session.record,
                passkey: {
                    credentialId: credential.id,
                    userId: user.id,
                    publicKey: credential.publicKey,
                    counter: credential.counter,
                    transports: credential.transports,
                    backedUp: credential.backedUp,
                    aaguid: credential.aaguid,
                    addedVia: 'recovery',
                    createdAt: now,
                    // The registration signs in, so this passkey has just been used.
                    lastUsedAt: now,
                    counterRegressedAt: null,
                },
            });
            if (recovered === 'conflict') {
                return { kind: 'conflict' };
            }
            const notice = {
                template: 'recovery-notice',
                to: user.email,
                locale: user.locale,
                recoveredAt: now,
                cooldownEndsAt: now + RECOVERY_COOLDOWN_MS,
                signInLink: deps.links.signIn(),
            } as const;
            return {
                kind: 'ok',
                session,
                deliver: () => runInBackground(deps, 'recovery-notice', (signal) => deps.email.send(notice, signal)),
            };
        },
    };
}
