import type { EngineApiClient, ReadOnboardingState } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';

export const onboardingKeys = { state: ['onboarding'] as const };

/** How often to ask again while the engine works, a harness sign-in waits, or a step needs a newer UI. */
export const ONBOARDING_POLL_MS = 2_000;

/**
 * Whether the state can change without the member doing anything here, so the UI should look again soon. A step of a
 * kind this UI does not know is answered on the host, so it settles from there.
 */
export function isSettling(state: ReadOnboardingState | undefined): boolean {
    if (state === undefined) return false;
    if (state.status === 'working') return true;
    const prompt = state.prompt;
    if (prompt?.kind === 'unsupported') return true;
    return prompt?.kind === 'harness-login' && (prompt.status === 'waiting' || prompt.status === 'verifying');
}

/**
 * A paired engine with no project yet: setup is all there is, so the shell shows nothing else and every path leads to
 * it until it is done.
 */
export function isSetupOnly(state: ReadOnboardingState | undefined): boolean {
    return state !== undefined && state.status !== 'completed' && !state.canDefer;
}

export function onboardingQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: onboardingKeys.state,
        queryFn: async ({ signal }) => unwrap(await engineApi.onboarding.get(signal)),
        refetchInterval: (query) => (isSettling(query.state.data) ? ONBOARDING_POLL_MS : false),
    });
}
