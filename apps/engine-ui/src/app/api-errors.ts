import { EngineApiContractError } from '@ptbk/engine-api';
import type { EngineApiResponse, ProblemDetails } from '@ptbk/engine-api';

/** A problem+json answer, thrown so TanStack Query and route error boundaries see it as a failure. */
export class EngineApiProblemError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails) {
        super(`Engine API problem: ${problem.code}`);
        this.name = 'EngineApiProblemError';
        this.problem = problem;
    }
}

export function unwrap<T>(response: EngineApiResponse<T>): T {
    switch (response.kind) {
        case 'ok':
            return response.data;
        case 'problem':
            throw new EngineApiProblemError(response.problem);
    }
}

/** Every way an engine API call can fail, as the UI distinguishes them. */
export type ApiFailure =
    | { readonly kind: 'problem'; readonly problem: ProblemDetails }
    | { readonly kind: 'contract' }
    | { readonly kind: 'timeout' }
    | { readonly kind: 'aborted' }
    | { readonly kind: 'network' }
    | { readonly kind: 'unexpected' };

/** The one place that maps what the client rejects or resolves with to a failure kind. */
export function classifyApiError(error: unknown): ApiFailure {
    if (error instanceof EngineApiProblemError) return { kind: 'problem', problem: error.problem };
    if (error instanceof EngineApiContractError) return { kind: 'contract' };
    // fetch rejects with a TypeError when the request never got an answer.
    if (error instanceof TypeError) return { kind: 'network' };
    const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
    if (name === 'TimeoutError') return { kind: 'timeout' };
    if (name === 'AbortError') return { kind: 'aborted' };
    return { kind: 'unexpected' };
}

/** `step-up-required` is a 401 too, but the session is fine: it needs a fresh passkey assertion, not a new sign-in. */
export function isUnauthenticated(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.code === 'unauthenticated';
}

const MAX_QUERY_RETRIES = 2;

/** No retry on 4xx or contract errors (they would fail the same way); at most two on network errors and 5xx. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
    if (failureCount >= MAX_QUERY_RETRIES) return false;
    const failure = classifyApiError(error);
    switch (failure.kind) {
        case 'problem':
            return failure.problem.status >= 500;
        case 'network':
        case 'timeout':
            return true;
        case 'contract':
        case 'aborted':
        case 'unexpected':
            return false;
    }
}
