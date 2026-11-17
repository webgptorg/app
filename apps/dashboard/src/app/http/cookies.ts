/** `__Host-`: Secure, Path=/ and no Domain, so no other host, subdomain or path can set or shadow it. */
export const SESSION_COOKIE = '__Host-ptbk_session';
/** Binds a WebAuthn challenge to the browser that asked for it. */
export const CHALLENGE_COOKIE = '__Host-ptbk_chal';

function serialize(name: string, value: string, maxAgeSeconds: number, sameSite: 'Lax' | 'Strict'): string {
    return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Secure; HttpOnly; SameSite=${sameSite}`;
}

/**
 * Lax, not Strict: links from alert emails and the engine UI's "back to dashboard" must arrive signed in. Cross-site
 * writes are refused by the Fetch Metadata check instead (`csrf.ts`).
 */
export function sessionCookie(token: string, expiresAt: number, now: number): string {
    return serialize(SESSION_COOKIE, token, Math.max(0, Math.floor((expiresAt - now) / 1000)), 'Lax');
}

export function clearSessionCookie(): string {
    return serialize(SESSION_COOKIE, '', 0, 'Lax');
}

export function challengeCookie(challengeId: string, ttlMs: number): string {
    return serialize(CHALLENGE_COOKIE, challengeId, Math.floor(ttlMs / 1000), 'Strict');
}

export function clearChallengeCookie(): string {
    return serialize(CHALLENGE_COOKIE, '', 0, 'Strict');
}

/**
 * The invitation token, so the invitation page still has it after a reload or in another tab (D-31). Strict: only the
 * page's own requests send it. An hour is plenty to finish joining; the emailed link sets it again.
 */
export const INVITE_COOKIE = '__Host-ptbk_invite';
export const INVITE_COOKIE_TTL_MS = 60 * 60 * 1000;

export function inviteCookie(token: string, ttlMs: number): string {
    return serialize(INVITE_COOKIE, token, Math.max(0, Math.floor(ttlMs / 1000)), 'Strict');
}

export function clearInviteCookie(): string {
    return serialize(INVITE_COOKIE, '', 0, 'Strict');
}

/** The token a request names, else the one the invitation page's cookie holds. */
export function inviteToken(
    fromBody: string | undefined,
    request: { secretCookie(name: string): string | null },
): string | null {
    return fromBody ?? request.secretCookie(INVITE_COOKIE);
}
