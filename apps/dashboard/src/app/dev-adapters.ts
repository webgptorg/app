import { createFakeBillingState, type FakeBillingState } from '../adapters/billing/fake-billing-provider';
import { createFakeEmailSender, type FakeEmailSender } from '../adapters/email/fake-email-sender';
import type { MemoryRateLimitWindows } from '../adapters/rate-limit/memory-rate-limiter';
import {
    createMemoryDashboardMetrics,
    type MemoryDashboardMetrics,
} from '../adapters/monitoring/memory-dashboard-metrics';
import { systemClock } from '../adapters/system-clock';

/** State the dev-only adapters keep across requests; created once per isolate by the Worker entry. */
export interface DevAdapters {
    readonly outbox: FakeEmailSender;
    /** The memory rate limiter's counters; the limiter is built per request with the configured rules. */
    readonly rateLimitWindows: MemoryRateLimitWindows;
    readonly billing: FakeBillingState;
    /** The dashboard's counters in dev, where the monitoring job also reads them back (I-04). */
    readonly metrics: MemoryDashboardMetrics;
}

export function createDevAdapters(): DevAdapters {
    return {
        outbox: createFakeEmailSender(),
        rateLimitWindows: new Map(),
        billing: createFakeBillingState(),
        metrics: createMemoryDashboardMetrics(systemClock),
    };
}
