import type { EngineApiClient, OnboardingState } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';

export const onboardingKeys = { state: ['onboarding'] as const };

/** How often to ask again while the engine works or a harness sign-in waits for the provider. */
export const ONBOARDING_POLL_MS = 2_000;

/** Whether the state can change without the member doing anything, so the UI should look again soon. */
export function isSettling(state: OnboardingState | undefined): boolean {
    if (state === undefined) return false;
    if (state.status === 'working') return true;
    const prompt = state.prompt;
    return prompt?.kind === 'harness-login' && (prompt.status === 'waiting' || prompt.status === 'verifying');
}

export function onboardingQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: onboardingKeys.state,
        queryFn: async ({ signal }) => unwrap(await engineApi.onboarding.get(signal)),
        refetchInterval: (query) => (isSettling(query.state.data) ? ONBOARDING_POLL_MS : false),
    });
}
