import type { EngineApiClient, ReadEngineEvent } from '@ptbk/engine-api';

export interface EngineEventSubscriber {
    readonly onEvent: (event: ReadEngineEvent) => void;
    /**
     * The stream came back after a gap. Events in the gap may be lost (the engine buffers only so many), so whatever
     * a subscriber derived from them should be refetched once.
     */
    readonly onReconnect?: () => void;
}

/** The engine's `GET /events` stream, shared: one connection while anyone listens, none otherwise. */
export interface EngineEvents {
    subscribe(subscriber: EngineEventSubscriber): () => void;
}

export interface EngineEventsDeps {
    readonly engineApi: EngineApiClient;
    /** Wait before reconnect attempt `attempt` (1, 2, …). */
    readonly retryDelayMs?: (attempt: number) => number;
    readonly setTimeout?: (callback: () => void, ms: number) => unknown;
    readonly clearTimeout?: (handle: unknown) => void;
    /** Where a subscriber's exception goes; by default it surfaces as an uncaught error. */
    readonly reportError?: (error: unknown) => void;
    /** The session ended. Nothing else may be asking the engine, so the stream must say it, or the app goes quiet. */
    readonly onUnauthenticated?: () => void;
}

const MAX_RETRY_DELAY_MS = 30_000;

export function defaultRetryDelayMs(attempt: number): number {
    return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** (attempt - 1));
}

/** A refusal that a retry would only repeat: the member lacks the permission, or the engine has no such stream. */
function isFinalRefusal(status: number): boolean {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * One app-wide subscription to the engine's change events, resumed with `Last-Event-ID` after a drop or a pause. It
 * connects when the first subscriber arrives and disconnects when the last one leaves; nothing polls.
 */
export function createEngineEvents(deps: EngineEventsDeps): EngineEvents {
    const retryDelayMs = deps.retryDelayMs ?? defaultRetryDelayMs;
    const schedule = deps.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    const cancel =
        deps.clearTimeout ??
        ((handle) => {
            globalThis.clearTimeout(handle as number);
        });
    const reportError =
        deps.reportError ??
        ((error: unknown) => {
            queueMicrotask(() => {
                throw error;
            });
        });
    const subscribers = new Set<EngineEventSubscriber>();
    let lastEventId: string | undefined;
    let connectedOnce = false;
    let refused = false;
    let attempt = 0;
    let controller: AbortController | undefined;
    let timer: unknown;

    const notify = (deliver: (subscriber: EngineEventSubscriber) => void) => {
        for (const subscriber of [...subscribers]) {
            try {
                deliver(subscriber);
            } catch (error) {
                // A subscriber's bug must not cut the stream for everyone else.
                reportError(error);
            }
        }
    };

    const retryLater = () => {
        attempt += 1;
        timer = schedule(() => {
            timer = undefined;
            void connect();
        }, retryDelayMs(attempt));
    };

    const connect = async () => {
        const current = new AbortController();
        controller = current;
        try {
            const response = await deps.engineApi.events.stream(
                lastEventId === undefined ? {} : { lastEventId },
                current.signal,
            );
            if (current.signal.aborted) return;
            if (response.kind === 'problem') {
                if (isFinalRefusal(response.problem.status)) {
                    refused = true;
                    if (response.problem.code === 'unauthenticated') deps.onUnauthenticated?.();
                    return;
                }
                retryLater();
                return;
            }
            if (connectedOnce) notify((subscriber) => subscriber.onReconnect?.());
            connectedOnce = true;
            for await (const item of response.data) {
                // Only a stream that delivers resets the backoff, so one that keeps closing at once is retried ever
                // more slowly instead of refetching every second.
                attempt = 0;
                if (item.id !== null) lastEventId = item.id;
                notify((subscriber) => {
                    subscriber.onEvent(item.event);
                });
            }
        } catch {
            // A dropped connection or a timeout; the next attempt resumes after the last event seen.
        }
        if (!current.signal.aborted) retryLater();
    };

    const start = () => {
        if (refused) return;
        void connect();
    };

    const stop = () => {
        // A refusal holds for this subscription only; the next one asks again (the session may have changed).
        refused = false;
        controller?.abort();
        controller = undefined;
        if (timer !== undefined) cancel(timer);
        timer = undefined;
        attempt = 0;
    };

    return {
        subscribe(subscriber) {
            subscribers.add(subscriber);
            if (subscribers.size === 1) start();
            return () => {
                if (!subscribers.delete(subscriber)) return;
                if (subscribers.size === 0) stop();
            };
        },
    };
}
