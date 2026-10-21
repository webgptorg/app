import { z } from 'zod';

import type { MemberListParams } from './members-keys';

/** The members table's state in the URL: only the cursor, since the engine lists members in one order. */
export const MemberListSearch = z.object({
    cursor: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,1024}$/)
        .optional()
        .catch(undefined),
});
export type MemberListSearch = z.output<typeof MemberListSearch>;

export function memberListParams(search: MemberListSearch): MemberListParams {
    return search.cursor === undefined ? {} : { cursor: search.cursor };
}
