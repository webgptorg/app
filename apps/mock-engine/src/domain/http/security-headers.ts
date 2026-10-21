import { ENGINE_UI_CSP } from '@ptbk/engine-api';

/**
 * The engine's browser headers (spec, Engine security baseline: Browser headers), on every response inside the tunnel:
 * UI files, API, gateway pages and errors alike. They are engine code: nothing in a UI bundle, its manifest's `csp`
 * included, can loosen them. The CSP is `ENGINE_UI_CSP` byte for byte, the one string the bundle, the mock engine,
 * conformance and the real engine share.
 */
const ENGINE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
    'Content-Security-Policy': ENGINE_UI_CSP,
    'Strict-Transport-Security': 'max-age=31536000',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
});

export function engineSecurityHeaders(): Readonly<Record<string, string>> {
    return ENGINE_SECURITY_HEADERS;
}
