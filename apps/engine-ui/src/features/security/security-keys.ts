import type { PageQuery } from '@ptbk/engine-api';
import type { z } from 'zod';

export type PasskeyListParams = z.input<typeof PageQuery>;

export const securityKeys = {
    all: ['security'] as const,
    overview: () => [...securityKeys.all, 'overview'] as const,
    passkeys: () => [...securityKeys.all, 'passkeys'] as const,
    myPasskeys: (params: PasskeyListParams) => [...securityKeys.passkeys(), 'mine', params] as const,
    allPasskeys: (params: PasskeyListParams) => [...securityKeys.passkeys(), 'all', params] as const,
    mySessions: () => [...securityKeys.all, 'my-sessions'] as const,
    settings: () => [...securityKeys.all, 'settings'] as const,
};
