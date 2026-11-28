/** What a `/signup#…`, `/recover#…` or `/unsubscribe#…` link carried: a well-formed token, something else, or nothing. */
export type FragmentToken =
    { readonly kind: 'none' } | { readonly kind: 'token'; readonly token: string } | { readonly kind: 'malformed' };

export type TokenPurpose = 'signup' | 'recovery' | 'invite' | 'unsubscribe';

/** 256-bit email tokens, base64url, as `src/shared/api/routes.ts` accepts them. */
const EMAIL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/**
 * A signed unsubscribe token (D-41) within the route's size cap; its parts and signature are the server's to check, the
 * page only refuses what could not be one.
 */
export const UNSUBSCRIBE_TOKEN = /^[A-Za-z0-9._~-]{1,400}$/;

export function parseFragmentToken(hash: string, pattern: RegExp = EMAIL_TOKEN): FragmentToken {
    const value = hash.startsWith('#') ? hash.slice(1) : hash;
    if (value === '') {
        return { kind: 'none' };
    }
    return pattern.test(value) ? { kind: 'token', token: value } : { kind: 'malformed' };
}

/**
 * Hands an emailed token from the route that read it to the page that uses it, in memory only. The route removes the
 * fragment from the address bar before the page renders (a replacing redirect, i.e. `history.replaceState`), so the
 * token is in no history entry, no storage and no later URL. The page reads it into its state on mount and then
 * forgets it here; reading does not consume, because React may run a state initializer twice in development.
 */
export interface FragmentTokens {
    readonly put: (purpose: TokenPurpose, token: FragmentToken) => void;
    readonly peek: (purpose: TokenPurpose) => FragmentToken;
    readonly forget: (purpose: TokenPurpose) => void;
    /** Counts arrivals, so a page that is already showing remounts for a link opened in its own tab. */
    readonly arrivals: () => number;
    readonly subscribe: (listener: () => void) => () => void;
}

export function createFragmentTokens(): FragmentTokens {
    const held = new Map<TokenPurpose, FragmentToken>();
    const listeners = new Set<() => void>();
    let arrivals = 0;
    return {
        put: (purpose, token) => {
            held.set(purpose, token);
            arrivals += 1;
            for (const listener of listeners) {
                listener();
            }
        },
        peek: (purpose) => held.get(purpose) ?? { kind: 'none' },
        forget: (purpose) => {
            held.delete(purpose);
        },
        arrivals: () => arrivals,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
