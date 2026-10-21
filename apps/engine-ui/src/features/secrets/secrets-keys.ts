import type { SecretListQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type SecretListParams = z.input<typeof SecretListQuery>;

export const secretKeys = {
    all: ['secrets'] as const,
    lists: () => [...secretKeys.all, 'list'] as const,
    list: (params: SecretListParams) => [...secretKeys.lists(), params] as const,
};
