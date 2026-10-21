import { createFakeBillingState, type FakeBillingState } from '../adapters/billing/fake-billing-provider';
import { createFakeEmailSender, type FakeEmailSender } from '../adapters/email/fake-email-sender';
import type { MemoryRateLimitWindows } from '../adapters/rate-limit/memory-rate-limiter';

/** State the dev-only adapters keep across requests; created once per isolate by the Worker entry. */
export interface DevAdapters {
    readonly outbox: FakeEmailSender;
    /** The memory rate limiter's counters; the limiter is built per request with the configured rules. */
    readonly rateLimitWindows: MemoryRateLimitWindows;
    readonly billing: FakeBillingState;
}

export function createDevAdapters(): DevAdapters {
    return {
        outbox: createFakeEmailSender(),
        rateLimitWindows: new Map(),
        billing: createFakeBillingState(),
    };
}
