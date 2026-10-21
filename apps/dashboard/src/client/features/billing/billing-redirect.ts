/** The API named somewhere the SPA will not send the browser; reported like any failed action. */
export class UnsafeRedirectError extends Error {
    constructor() {
        super('refused to navigate to an unexpected URL');
        this.name = 'UnsafeRedirectError';
    }
}

/**
 * Checkout and the portal live on Stripe's https origin, the fake adapter answers with our own `/billing`. Anything
 * else is refused even though the API contract already allows only http(s): the SPA is the last step before the
 * browser leaves, so it checks again rather than trusting one layer.
 */
export function isAllowedRedirect(url: string, origin: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return parsed.protocol === 'https:' || parsed.origin === origin;
}
