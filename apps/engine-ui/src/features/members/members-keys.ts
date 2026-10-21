import type { MemberId, PageQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type MemberListParams = z.input<typeof PageQuery>;

export const memberKeys = {
    all: ['members'] as const,
    lists: () => [...memberKeys.all, 'list'] as const,
    list: (params: MemberListParams) => [...memberKeys.lists(), params] as const,
    detail: (memberId: MemberId) => [...memberKeys.all, 'detail', memberId] as const,
};
