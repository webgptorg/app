import { SECRET_SORTS, SecretStatus } from '@ptbk/engine-api';
import { z } from 'zod';

import type { SecretListParams } from './secrets-keys';

export const DEFAULT_SECRET_SORT = 'name';
export const SECRET_SCOPE_KINDS = ['engine', 'agent'] as const;

/** The table's state in the URL; a bad value falls back to the default instead of throwing. */
export const SecretListSearch = z.object({
    q: z.string().trim().min(1).max(128).optional().catch(undefined),
    scope: z.enum(SECRET_SCOPE_KINDS).optional().catch(undefined),
    status: SecretStatus.optional().catch(undefined),
    sort: z.enum(SECRET_SORTS).default(DEFAULT_SECRET_SORT).catch(DEFAULT_SECRET_SORT),
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
});
export type SecretListSearch = z.output<typeof SecretListSearch>;

/** Everything goes to the engine; nothing is filtered or sorted on the client. */
export function secretListParams(search: SecretListSearch): SecretListParams {
    return {
        sort: search.sort,
        ...(search.q === undefined ? {} : { q: search.q }),
        ...(search.scope === undefined ? {} : { scope: search.scope }),
        ...(search.status === undefined ? {} : { status: search.status }),
        ...(search.cursor === undefined ? {} : { cursor: search.cursor }),
    };
}
