import type { RouteContract } from '../../shared/api/contract';
import type { ApiClient, ApiOutcome } from './api-client';

/** In-memory {@link ApiClient} for component tests: answers each contract with a canned outcome. */
export function createFakeApiClient(
    outcomes: ReadonlyMap<RouteContract, ApiOutcome<RouteContract>>,
): ApiClient & { readonly calls: readonly RouteContract[] } {
    const calls: RouteContract[] = [];
    return {
        calls,
        call<C extends RouteContract>(contract: C) {
            calls.push(contract);
            const outcome = outcomes.get(contract) ?? { kind: 'network-error' };
            // The map is keyed by the contract, so the outcome is that contract's.
            return Promise.resolve(outcome as ApiOutcome<C>);
        },
    };
}
