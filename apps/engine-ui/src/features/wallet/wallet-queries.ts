import type { EngineApiClient } from '@ptbk/engine-api';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';

/** Agent requests arrive while the page is open, so the overview refreshes on its own. */
const WALLET_REFRESH_MS = 30_000;

export const walletKeys = {
    all: ['wallet'] as const,
};

/** `GET /wallet`: readiness, logins without secrets and the pending agent requests, in one answer. */
export function walletQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: walletKeys.all,
        queryFn: async ({ signal }) => unwrap(await engineApi.wallet.get(signal)),
        staleTime: WALLET_REFRESH_MS,
        refetchInterval: WALLET_REFRESH_MS,
    });
}

export function useWallet() {
    return useQuery(walletQueryOptions(useEngineApi()));
}
