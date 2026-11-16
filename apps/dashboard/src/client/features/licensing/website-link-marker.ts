import type { PreferenceStorage } from '@ptbk/ui';

const KEY = 'ptbk.website-link-until';
export const WEBSITE_ACCESS_PATH = '/website-access';

/**
 * Remembers, until the pending link expires, that this browser came from ptbk.io, so the sign-up finished from the
 * emailed link (often in a new tab) returns to `/website-access`. A hint only: the identity sits in an HttpOnly
 * cookie, and the server decides everything.
 */
export function rememberWebsiteLink(storage: PreferenceStorage | undefined, expiresAt: number): void {
    try {
        storage?.setItem(KEY, String(expiresAt));
    } catch {
        // Storage refused: the person can still link from the License page.
    }
}

export function forgetWebsiteLink(storage: PreferenceStorage | undefined): void {
    try {
        storage?.setItem(KEY, '0');
    } catch {
        // Nothing to forget.
    }
}

/** Where to land after signing up: back to the link while it can still finish, the default otherwise. */
export function afterSignUp(storage: PreferenceStorage | undefined, now: number): string | undefined {
    try {
        return Number(storage?.getItem(KEY) ?? '0') > now ? WEBSITE_ACCESS_PATH : undefined;
    } catch {
        return undefined;
    }
}
