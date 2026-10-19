const PRODUCTION_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    // Also makes "the dashboard never fetches engine data" browser-enforced.
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
].join('; ');

/**
 * Only under the Vite dev server: React Refresh injects an inline preamble, Vite injects styles and an HMR socket.
 * Built output, the dev container and every CSP test use {@link PRODUCTION_CSP}.
 */
const VITE_DEV_SERVER_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss:",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
].join('; ');

const COMMON_HEADERS = {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Opener-Policy': 'same-origin',
} as const;

export function securityHeaders(mode: 'production' | 'vite-dev-server'): Readonly<Record<string, string>> {
    switch (mode) {
        case 'production':
            return {
                ...COMMON_HEADERS,
                'Content-Security-Policy': PRODUCTION_CSP,
                'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
            };
        case 'vite-dev-server':
            // No HSTS: under `dev:https` it would pin localhost to HTTPS in the developer's browser for two years.
            return { ...COMMON_HEADERS, 'Content-Security-Policy': VITE_DEV_SERVER_CSP };
    }
}

/** Responses from bindings such as ASSETS can have immutable headers, so this always copies. */
export function withHeaders(response: Response, headers: Readonly<Record<string, string>>): Response {
    const copy = new Response(response.body, response);
    for (const [name, value] of Object.entries(headers)) {
        copy.headers.set(name, value);
    }
    return copy;
}
