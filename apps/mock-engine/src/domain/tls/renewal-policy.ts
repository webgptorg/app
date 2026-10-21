/** The validity window of a certificate, in milliseconds since the Unix epoch. */
export interface CertificateValidity {
    readonly notBeforeMs: number;
    readonly notAfterMs: number;
}

/** How often a held certificate is looked at even when nothing is due, as certbot and Caddy do. */
export const RENEWAL_CHECK_INTERVAL_MS = 12 * 3_600_000;

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 3_600_000;

/**
 * When to renew: once less than a third of the lifetime remains (60 of 90 days at Let's Encrypt today, and still
 * sensible as lifetimes shrink). An ACME Renewal Information window, once the client supports ARI, would replace this
 * moment and nothing else.
 */
export function renewalDueAtMs(validity: CertificateValidity): number {
    const lifetimeMs = Math.max(0, validity.notAfterMs - validity.notBeforeMs);
    return validity.notAfterMs - lifetimeMs / 3;
}

export function renewalDue(validity: CertificateValidity, nowMs: number): boolean {
    return nowMs >= renewalDueAtMs(validity);
}

/** The next look at a held certificate: every 12 h, or at the moment renewal falls due if that comes first. */
export function nextRenewalCheckMs(validity: CertificateValidity, nowMs: number): number {
    return Math.max(0, Math.min(RENEWAL_CHECK_INTERVAL_MS, renewalDueAtMs(validity) - nowMs));
}

/** Delay before retry `failures` (1 for the first): 5 s doubling to an hour, so a broken CA is not hammered. */
export function renewalRetryDelayMs(failures: number): number {
    const exponent = Math.max(0, Math.min(failures - 1, 20));
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}
