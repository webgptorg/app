import { AccessRequestId } from '@ptbk/engine-api';
import { z } from 'zod';

import type { MemberListParams } from './members-keys';

/**
 * The members page's state in the URL: the table's cursor (the engine lists members in one order) and `request`, an
 * access request whose approval dialog opens on arrival. The approver's email and Home link there.
 */
export const MemberListSearch = z.object({
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
    request: AccessRequestId.optional().catch(undefined),
});
export type MemberListSearch = z.output<typeof MemberListSearch>;

export function memberListParams(search: MemberListSearch): MemberListParams {
    return search.cursor === undefined ? {} : { cursor: search.cursor };
}
