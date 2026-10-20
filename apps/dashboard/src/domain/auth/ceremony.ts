import type { AuthenticationResponse } from '../../shared/api/webauthn';
import type { OrgId, UserId } from '../ids';
import type { RateLimitRuleName } from '../ports/rate-limiter';
import type { AuthDeps } from './auth-deps';
import type { CeremonyPurpose, ChallengeRecord, PasskeyRecord, SessionRecord, UserRecord } from './records';
import { newSecret, sha256Hex, toBase64Url } from './secrets';
import { CHALLENGE_TTL_MS, SESSION_ABSOLUTE_MS } from './timing';

/** Background work (email delivery) must not hang the Worker's `waitUntil` forever. */
export const BACKGROUND_TIMEOUT_MS = 10_000;

export type CeremonyFailure = 'challenge-invalid' | 'webauthn-failed';

/** Fails closed: a limiter that cannot decide counts as over the limit. */
export async function withinLimit(
    deps: AuthDeps,
    rule: RateLimitRuleName,
    key: string,
    signal: AbortSignal,
): Promise<boolean> {
    const outcome = await deps.rateLimiter.consume(rule, key, signal);
    if (outcome === 'unavailable') {
        deps.logger.error('rate-limit.unavailable', { rule });
    }
    return outcome === 'allowed';
}

/** Runs email delivery after the response; failures are logged by name only, never with the address or token. */
export async function runInBackground(
    deps: AuthDeps,
    flow: string,
    task: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
    try {
        await task(AbortSignal.timeout(BACKGROUND_TIMEOUT_MS));
    } catch (error) {
        deps.logger.error('auth.background-failed', { flow, error: error instanceof Error ? error.name : 'unknown' });
    }
}

export async function issueChallenge(
    deps: AuthDeps,
    input: {
        readonly purpose: CeremonyPurpose;
        readonly userId?: UserId;
        readonly tokenHash?: string;
        readonly webauthnUserId?: Uint8Array;
    },
): Promise<ChallengeRecord> {
    const now = deps.clock.nowMs();
    const record: ChallengeRecord = {
        id: newSecret(deps.random),
        challenge: toBase64Url(deps.random.bytes(32)),
        purpose: input.purpose,
        userId: input.userId ?? null,
        tokenHash: input.tokenHash ?? null,
        webauthnUserId: input.webauthnUserId ?? null,
        expiresAt: now + CHALLENGE_TTL_MS,
    };
    await deps.store.challenges.create(record, now);
    return record;
}

/**
 * Consumes the challenge before anything is checked, so a failed, mismatched or concurrent verify can never reuse it.
 * Returns it only if it was issued for this purpose and, where given, this user and email token.
 */
export async function consumeChallenge(
    deps: AuthDeps,
    challengeId: string | null,
    expected: { readonly purpose: CeremonyPurpose; readonly userId?: UserId; readonly tokenHash?: string },
): Promise<ChallengeRecord | null> {
    if (challengeId === null) {
        return null;
    }
    const record = await deps.store.challenges.consume(challengeId, deps.clock.nowMs());
    const matches =
        record !== null &&
        record.purpose === expected.purpose &&
        (expected.userId === undefined || record.userId === expected.userId) &&
        (expected.tokenHash === undefined || record.tokenHash === expected.tokenHash);
    return matches ? record : null;
}

/**
 * Verifies an assertion against a stored passkey. In usernameless sign-in the returned `userHandle` must be the
 * credential owner's handle; elsewhere it must match if the authenticator sends one. A signature counter that does
 * not move forward from a non-zero value marks the passkey as possibly cloned and fails the ceremony.
 */
export async function assertPasskey(
    deps: AuthDeps,
    input: {
        readonly response: AuthenticationResponse;
        readonly challenge: ChallengeRecord;
        readonly owner: UserId | 'any';
    },
): Promise<
    | { readonly kind: 'ok'; readonly user: UserRecord; readonly passkey: PasskeyRecord }
    | { readonly kind: 'webauthn-failed' }
> {
    const failed = { kind: 'webauthn-failed' } as const;
    const passkey = await deps.store.passkeys.find(input.response.id);
    if (passkey === null || (input.owner !== 'any' && passkey.userId !== input.owner)) {
        return failed;
    }
    const user = await deps.store.accounts.findUser(passkey.userId);
    if (user === null) {
        return failed;
    }
    const userHandle = input.response.response.userHandle;
    const handleRequired = input.owner === 'any';
    if ((handleRequired || userHandle !== undefined) && userHandle !== toBase64Url(user.webauthnUserId)) {
        return failed;
    }
    const verification = await deps.relyingParty.verifyAuthentication({
        response: input.response,
        expectedChallenge: input.challenge.challenge,
        credential: { id: passkey.credentialId, publicKey: passkey.publicKey },
    });
    if (verification.kind === 'rejected') {
        return failed;
    }
    const now = deps.clock.nowMs();
    if (passkey.counter > 0 && verification.newCounter <= passkey.counter) {
        await deps.store.passkeys.flagCounterRegression(user.id, passkey.credentialId, now);
        deps.logger.warn('auth.passkey-counter-regression', { userId: user.id });
        return failed;
    }
    await deps.store.passkeys.recordUse(user.id, passkey.credentialId, verification.newCounter, now);
    return { kind: 'ok', user, passkey };
}

export interface IssuedSession {
    /** The cookie value; only its SHA-256 is stored. */
    readonly token: string;
    readonly record: SessionRecord;
}

/** Always a new ID, so a session fixed before sign-in is never promoted. */
export async function newSession(
    deps: AuthDeps,
    input: { readonly userId: UserId; readonly orgId: OrgId; readonly steppedUp: boolean },
): Promise<IssuedSession> {
    const now = deps.clock.nowMs();
    const token = newSecret(deps.random);
    return {
        token,
        record: {
            idHash: await sha256Hex(token),
            userId: input.userId,
            activeOrgId: input.orgId,
            createdAt: now,
            lastSeenAt: now,
            expiresAt: now + SESSION_ABSOLUTE_MS,
            steppedUpAt: input.steppedUp ? now : null,
            revokedAt: null,
        },
    };
}
