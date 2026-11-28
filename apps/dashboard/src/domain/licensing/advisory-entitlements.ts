import type { Entitlements } from '../billing/entitlements';

/** Only billing restrictions become advisory. Roles, ownership, security and issuance rate limits still apply. */
export function createAdvisoryEntitlements(): Entitlements {
    return {
        allows: () => Promise.resolve(true),
        limit: () => Promise.resolve(null),
        // The licence's own check points decide for its grants (ADR 0021); a meter limit here never blocks.
        overLimit: () => Promise.resolve('warn'),
    };
}
