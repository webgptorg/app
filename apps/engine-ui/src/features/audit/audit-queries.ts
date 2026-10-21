import type { EngineApiClient } from '@ptbk/engine-api';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { isPageLevelFailure } from '../../app/list-errors';
import { auditKeys } from './audit-keys';
import type { AuditListParams } from './audit-keys';

// The log only changes on the reader's "Refresh": rows must not shift while someone reads them.
const AUDIT_STALE_MS = 5 * 60_000;

/** `GET /audit`, newest first; filters and paging happen on the engine. */
export function auditLogQueryOptions(engineApi: EngineApiClient, params: AuditListParams) {
    return queryOptions({
        queryKey: auditKeys.list(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.audit.list(params, signal)),
        staleTime: AUDIT_STALE_MS,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
}

/** `GET /audit/verify`: the engine's own re-walk of the hash chain. The UI does not verify it (U-07, Risks). */
export function auditChainStatusQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: auditKeys.chainStatus(),
        queryFn: async ({ signal }) => unwrap(await engineApi.audit.verify(signal)),
        staleTime: AUDIT_STALE_MS,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
}

/** One page of the log; the previous page stays on screen while the next one loads. */
export function useAuditLog(filters: AuditListParams) {
    return useQuery({
        ...auditLogQueryOptions(useEngineApi(), filters),
        placeholderData: keepPreviousData,
        throwOnError: isPageLevelFailure,
    });
}

export function useAuditChainStatus() {
    return useQuery({ ...auditChainStatusQueryOptions(useEngineApi()), throwOnError: isPageLevelFailure });
}
