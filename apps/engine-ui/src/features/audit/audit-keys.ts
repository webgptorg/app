import type { AuditListQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type AuditListParams = z.input<typeof AuditListQuery>;

export const auditKeys = {
    all: ['audit'] as const,
    lists: () => [...auditKeys.all, 'list'] as const,
    list: (params: AuditListParams) => [...auditKeys.lists(), params] as const,
    chainStatus: () => [...auditKeys.all, 'verify'] as const,
};
