import type { ProblemCode } from '@ptbk/engine-api';
import { createProblem } from '@ptbk/engine-api';

import type { Clock } from '../../domain/clock';
import type { FaultDecision, FaultInjector } from '../../domain/faults/fault-injector';
import type { FaultPlan } from '../../domain/faults/fault-plan';

/** The contract's problem for each status a plan may inject; `reply-failed` is its only 502. */
const ERROR_PROBLEMS: Readonly<Record<FaultPlan['errorStatus'], ProblemCode>> = {
    500: 'internal-error',
    502: 'reply-failed',
    503: 'unavailable',
};

export interface Faults {
    readonly injector: FaultInjector;
    readonly clock: Clock;
}

function sleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const abort = (): void => {
            cancel();
            reject(signal.reason as Error);
        };
        const cancel = clock.setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}

/**
 * Faults for one request, decided up front: the latency is waited out, an injected error answers instead of the
 * route, and a stream picked for dropping is cut after its N-th event, as a dying connection would cut it.
 */
export async function withFaults(
    faults: Faults,
    path: string,
    signal: AbortSignal,
    route: () => Promise<Response>,
): Promise<Response> {
    const decision = faults.injector.decide(path);
    await sleep(faults.clock, decision.latencyMs, signal);
    if (decision.error !== null) {
        const problem = createProblem(ERROR_PROBLEMS[decision.error]);
        return new Response(JSON.stringify(problem), {
            status: problem.status,
            headers: { 'Content-Type': 'application/problem+json' },
        });
    }
    const response = await route();
    return dropStream(response, decision);
}

function dropStream(response: Response, decision: FaultDecision): Response {
    const after = decision.dropStreamAfterEvents;
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim();
    if (after === null || mediaType !== 'text/event-stream' || response.body === null) return response;
    const reader = response.body.getReader();
    let events = 0;
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const next = await reader.read();
            if (next.done) {
                controller.close();
                return;
            }
            controller.enqueue(next.value);
            // Encoded SSE messages end with a blank line, one per enqueued chunk.
            events += new TextDecoder().decode(next.value).split('\n\n').length - 1;
            if (events >= after) {
                await reader.cancel();
                controller.error(new Error('fault: stream dropped'));
            }
        },
        cancel: (reason: unknown) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, headers: response.headers });
}
