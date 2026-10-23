import type { Alert } from './alert-rules';

/** Where alerts go: email to the ops address first; chat or paging later, as further adapters. */
export interface AlertSink {
    /** Resolves once the alert was handed over; rejects on failure or when `signal` aborts. */
    send(alert: Alert, signal: AbortSignal): Promise<void>;
}
