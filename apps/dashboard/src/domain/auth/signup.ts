import type { RegistrationOptions, RegistrationResponse } from '../../shared/api/webauthn';
import { newOrgId, newUserId } from '../ids';
import type { Locale } from '../locale';
import type { AuthDeps } from './auth-deps';
import {
    consumeChallenge,
    issueChallenge,
    newSession,
    runInBackground,
    withinLimit,
    type IssuedSession,
} from './ceremony';
import type { EmailAddress } from './email-address';
import { newSecret, sha256Hex } from './secrets';
import { EMAIL_TOKEN_TTL_MS } from './timing';

/** Answer 202 and run the returned delivery after the response, so timing never reveals whether the address has an account. */
export type DeferredDelivery = () => Promise<void>;

export type TokenOptionsOutcome =
    | { readonly kind: 'ok'; readonly options: RegistrationOptions; readonly challengeId: string }
    | { readonly kind: 'token-invalid' };

export type RegistrationOutcome =
    | { readonly kind: 'ok'; readonly session: IssuedSession }
    | { readonly kind: 'challenge-invalid' | 'webauthn-failed' | 'token-invalid' | 'conflict' };

/** Email-first signup: the address is proven before an account exists, and the answer never says whether it had one. */
export function createSignupFlow(deps: AuthDeps) {
    async function deliver(email: EmailAddress, requestLocale: Locale, signal: AbortSignal): Promise<void> {
        if (!(await withinLimit(deps, 'signup-start-email', email, signal))) {
            return;
        }
        const existing = await deps.store.accounts.findUserByEmail(email);
        if (existing !== null) {
            await deps.email.send(
                {
                    template: 'account-exists',
                    to: email,
                    locale: existing.locale,
                    signInLink: deps.links.signIn(),
                    recoveryLink: deps.links.recover(),
                },
                signal,
            );
            return;
        }
        const token = newSecret(deps.random);
        const now = deps.clock.nowMs();
        await deps.store.emailTokens.issue({
            tokenHash: await sha256Hex(token),
            purpose: 'signup',
            email,
            userId: null,
            createdAt: now,
            expiresAt: now + EMAIL_TOKEN_TTL_MS,
            usedAt: null,
        });
        await deps.email.send(
            { template: 'signup-link', to: email, locale: requestLocale, link: deps.links.signup(token) },
            signal,
        );
    }

    return {
        start(input: { readonly email: EmailAddress; readonly locale: Locale }): DeferredDelivery {
            return () => runInBackground(deps, 'signup', (signal) => deliver(input.email, input.locale, signal));
        },

        async options(input: { readonly token: string }): Promise<TokenOptionsOutcome> {
            const tokenHash = await sha256Hex(input.token);
            const record = await deps.store.emailTokens.findUsable(tokenHash, 'signup', deps.clock.nowMs());
            if (record === null || (await deps.store.accounts.findUserByEmail(record.email)) !== null) {
                return { kind: 'token-invalid' };
            }
            const userHandle = deps.random.bytes(32);
            const challenge = await issueChallenge(deps, { purpose: 'signup', tokenHash, webauthnUserId: userHandle });
            const options = await deps.relyingParty.registrationOptions({
                challenge: challenge.challenge,
                userHandle,
                userName: record.email,
                exclude: [],
            });
            return { kind: 'ok', options, challengeId: challenge.id };
        },

        async verify(input: {
            readonly token: string;
            readonly challengeId: string | null;
            readonly response: RegistrationResponse;
            readonly locale: Locale;
        }): Promise<RegistrationOutcome> {
            const tokenHash = await sha256Hex(input.token);
            const challenge = await consumeChallenge(deps, input.challengeId, { purpose: 'signup', tokenHash });
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
            // Only now: a cancelled or failed ceremony leaves the emailed link usable for another try.
            const token = await deps.store.emailTokens.consume(tokenHash, 'signup', deps.clock.nowMs());
            if (token === null) {
                return { kind: 'token-invalid' };
            }
            const now = deps.clock.nowMs();
            const userId = newUserId(deps.random);
            const orgId = newOrgId(deps.random);
            const session = await newSession(deps, { userId, orgId, steppedUp: false });
            const { credential } = verification;
            const created = await deps.store.accounts.createAccount({
                user: {
                    id: userId,
                    email: token.email,
                    emailVerifiedAt: now,
                    locale: input.locale,
                    platformRole: 'none',
                    recoveredAt: null,
                    createdAt: now,
                    webauthnUserId: challenge.webauthnUserId,
                },
                org: { id: orgId, kind: 'personal', name: null, createdAt: now },
                membership: { orgId, userId, role: 'owner', createdAt: now },
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
                    // The registration signs in, so this passkey has just been used.
                    lastUsedAt: now,
                    counterRegressedAt: null,
                },
                session: session.record,
            });
            return created === 'created' ? { kind: 'ok', session } : { kind: 'conflict' };
        },
    };
}
