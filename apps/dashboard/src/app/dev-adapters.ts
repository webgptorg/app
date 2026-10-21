import { createFakeBillingState, type FakeBillingState } from '../adapters/billing/fake-billing-provider';
import { createFakeEmailSender, type FakeEmailSender } from '../adapters/email/fake-email-sender';
import { createMemoryRateLimiter } from '../adapters/rate-limit/memory-rate-limiter';
import { systemClock } from '../adapters/system-clock';
import type { RateLimiter } from '../domain/ports/rate-limiter';

/** State the dev-only adapters keep across requests; created once per isolate by the Worker entry. */
export interface DevAdapters {
    readonly outbox: FakeEmailSender;
    readonly rateLimiter: RateLimiter;
    readonly billing: FakeBillingState;
}

export function createDevAdapters(): DevAdapters {
    return {
        outbox: createFakeEmailSender(),
        rateLimiter: createMemoryRateLimiter(systemClock),
        billing: createFakeBillingState(),
    };
}
