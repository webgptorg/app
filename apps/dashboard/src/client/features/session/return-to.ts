const BASE = 'https://return-to.invalid';
/** Where a sign-in never returns to: it would loop, or land on a page that redirects a signed-in person anyway. */
const AUTH_PATHS = ['/continue', '/signin', '/signup', '/recover'];
const MAX_LENGTH = 2048;

/**
 * A same-origin path to go to after signing in, or `undefined`. Parsing against a fixed origin rejects
 * protocol-relative and backslash forms (`//evil.example`, `/\evil.example`) and anything absolute, so a crafted
 * `returnTo` can never send someone off the dashboard. The fragment is dropped: it could carry an emailed token.
 */
export function safeReturnTo(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_LENGTH) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(value, BASE);
    } catch {
        return undefined;
    }
    if (
        url.origin !== BASE ||
        AUTH_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))
    ) {
        return undefined;
    }
    return `${url.pathname}${url.search}`;
}
