const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export interface RateLimitRule {
    readonly limit: number;
    readonly windowMs: number;
}

/**
 * Rules ending in `-ip` are keyed by the client IP and may be a route's `rateLimit`, as may rules ending in `-relay`,
 * keyed by the authenticated relay's ID on `relay-token` routes. Rules ending in `-engine` are a route's
 * `engineRateLimit`, keyed by its `:engineId` path segment. The email rules are applied by the flows that send mail.
 * Production adapters only ever see an HMAC of the key.
 */
export const RATE_LIMITS = {
    'signup-start-ip': { limit: 10, windowMs: HOUR_MS },
    'signup-start-email': { limit: 3, windowMs: HOUR_MS },
    'recovery-request-ip': { limit: 10, windowMs: HOUR_MS },
    'recovery-request-email': { limit: 3, windowMs: HOUR_MS },
    // One budget for every endpoint that hands out a WebAuthn challenge to an anonymous caller.
    'options-ip': { limit: 30, windowMs: MINUTE_MS },
    // One budget shared by every WebAuthn verify endpoint.
    'verify-ip': { limit: 30, windowMs: MINUTE_MS },
    // Cheap public reads: the environment, health, the dev outbox.
    'public-read-ip': { limit: 120, windowMs: MINUTE_MS },
    // Engine registration (D-03): link codes are 128-bit, single-use and short-lived, so this caps load, not guessing.
    'registration-ip': { limit: 20, windowMs: HOUR_MS },
    // Stripe webhooks: generous, since Stripe sends bursts from few addresses and retries anything refused.
    'webhook-ip': { limit: 600, windowMs: MINUTE_MS },
    // Registry reads (D-04): each relay re-reads every connected engine once per 5-minute TTL, plus new tunnels.
    'registry-relay': { limit: 600, windowMs: MINUTE_MS },
    // Presence reports (R-07): one a minute plus at most one per 5-second change window, so about 13 at worst.
    'presence-relay': { limit: 30, windowMs: MINUTE_MS },
    // Heartbeats (D-05): many engines can share one address behind NAT or at a host.
    'heartbeat-ip': { limit: 600, windowMs: MINUTE_MS },
    // Keyed by the engine ID in the path; the limit is `config.heartbeat.perEngineLimit` (see `rateLimitRules`).
    'heartbeat-engine': { limit: 5, windowMs: MINUTE_MS },
} as const satisfies Readonly<Record<string, RateLimitRule>>;

export type RateLimitRuleName = keyof typeof RATE_LIMITS;

/** The limits an adapter counts with: {@link RATE_LIMITS}, with configured rules replaced. */
export type RateLimitRules = Readonly<Record<RateLimitRuleName, RateLimitRule>>;

/** `unavailable`: the limiter could not decide; callers fail closed and treat it as `limited`. */
export type RateLimitOutcome = 'allowed' | 'limited' | 'unavailable';

export interface RateLimiter {
    /** Counts one attempt against `rule` for `key`. */
    consume(rule: RateLimitRuleName, key: string, signal: AbortSignal): Promise<RateLimitOutcome>;
}
