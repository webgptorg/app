import {
    AgentId,
    DEFAULT_PAGE_LIMIT,
    INTEGRATION_STATUSES,
    IntegrationKindName,
    IntegrationStatus,
} from '@ptbk/engine-api';
import { z } from 'zod';

import type { IntegrationListParams } from './integrations-keys';

/** A set of statuses as the URL and the engine write it, `error` or `needs-attention,error`; in the canonical order. */
const StatusSet = z
    .string()
    .max(128)
    .transform((value, ctx) => {
        const parts = new Set(value.split(','));
        for (const part of parts) {
            if (!IntegrationStatus.safeParse(part).success) {
                ctx.addIssue({ code: 'custom', message: 'Unknown integration status.' });
                return z.NEVER;
            }
        }
        return INTEGRATION_STATUSES.filter((status) => parts.has(status)).join(',');
    })
    .refine((value) => value !== '');

/**
 * The integrations table's state in the URL, so a filtered page can be linked and survives a reload. A bad value falls
 * back to "no filter" instead of throwing. `kind` takes any kind name, so a link to a kind a newer engine added works.
 */
export const IntegrationSearch = z.object({
    kind: IntegrationKindName.optional().catch(undefined),
    status: StatusSet.optional().catch(undefined),
    agentId: AgentId.optional().catch(undefined),
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
});
export type IntegrationSearch = z.output<typeof IntegrationSearch>;

export function hasIntegrationFilters(search: IntegrationSearch, scope: 'global' | 'agent'): boolean {
    return (
        search.kind !== undefined || search.status !== undefined || (scope === 'global' && search.agentId !== undefined)
    );
}

/**
 * The engine's query. On an agent's tab the agent comes from the path, never from the search, and the engine-wide
 * integrations it may use are listed with its own.
 */
export function integrationListParams(search: IntegrationSearch, agentId?: AgentId): IntegrationListParams {
    const scope: Partial<IntegrationListParams> =
        agentId !== undefined
            ? { agentId, includeEngineWide: 'true' }
            : search.agentId === undefined
              ? {}
              : { agentId: search.agentId };
    return {
        limit: DEFAULT_PAGE_LIMIT,
        ...scope,
        ...(search.kind === undefined ? {} : { kind: search.kind }),
        ...(search.status === undefined ? {} : { status: search.status }),
        ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    };
}
