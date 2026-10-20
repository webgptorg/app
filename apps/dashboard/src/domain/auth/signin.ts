import type { AuthenticationOptions, AuthenticationResponse } from '../../shared/api/webauthn';
import type { AuthDeps } from './auth-deps';
import { assertPasskey, consumeChallenge, issueChallenge, newSession, type IssuedSession } from './ceremony';
import { sha256Hex } from './secrets';

export type SignInOutcome =
    | { readonly kind: 'ok'; readonly session: IssuedSession }
    | { readonly kind: 'challenge-invalid' | 'webauthn-failed' };

/** Usernameless sign-in with a discoverable passkey: the browser offers the passkeys it has for this rpID. */
export function createSignInFlow(deps: AuthDeps) {
    return {
        async options(): Promise<{ readonly options: AuthenticationOptions; readonly challengeId: string }> {
            const challenge = await issueChallenge(deps, { purpose: 'signin' });
            const options = deps.relyingParty.authenticationOptions({ challenge: challenge.challenge, allow: [] });
            return { options, challengeId: challenge.id };
        },

        async verify(input: {
            readonly challengeId: string | null;
            readonly response: AuthenticationResponse;
            /** The cookie of a session this browser already had; it is revoked, never reused. */
            readonly previousSessionToken: string | null;
        }): Promise<SignInOutcome> {
            const challenge = await consumeChallenge(deps, input.challengeId, { purpose: 'signin' });
            if (challenge === null) {
                return { kind: 'challenge-invalid' };
            }
            const asserted = await assertPasskey(deps, { response: input.response, challenge, owner: 'any' });
            if (asserted.kind === 'webauthn-failed') {
                return asserted;
            }
            const memberships = await deps.store.accounts.listMemberships(asserted.user.id);
            const membership = memberships[0];
            if (membership === undefined) {
                return { kind: 'webauthn-failed' };
            }
            if (input.previousSessionToken !== null) {
                await deps.store.sessions.revoke(await sha256Hex(input.previousSessionToken), deps.clock.nowMs());
            }
            // The assertion just now was user-verified, so it counts as a fresh step-up.
            const session = await newSession(deps, {
                userId: asserted.user.id,
                orgId: membership.orgId,
                steppedUp: true,
            });
            await deps.store.sessions.create(session.record);
            return { kind: 'ok', session };
        },
    };
}
