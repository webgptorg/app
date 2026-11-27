import { ENGINE_UI_CSP } from '@ptbk/engine-api';

/**
 * The engine's browser headers (spec, Engine security baseline: Browser headers), on every response inside the tunnel:
 * UI files, API, gateway pages and errors alike. They are engine code: nothing in a UI bundle, its manifest's `csp`
 * included, can loosen them. The CSP is `ENGINE_UI_CSP` byte for byte, the one string the bundle, the mock engine,
 * conformance and the real engine share.
 */
const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
    'Content-Security-Policy': ENGINE_UI_CSP,
    'Strict-Transport-Security': 'max-age=31536000',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
});

const WITHOUT_MICROPHONE = Object.freeze({
    ...BASE_HEADERS,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
});

/** Only the engine's own origin, never another, and only while `voice-input@1` is advertised (gateway.md). */
const WITH_MICROPHONE = Object.freeze({
    ...BASE_HEADERS,
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
});

export function engineSecurityHeaders(
    options: { readonly microphone: boolean } = { microphone: false },
): Readonly<Record<string, string>> {
    return options.microphone ? WITH_MICROPHONE : WITHOUT_MICROPHONE;
}
