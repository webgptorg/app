import type { QueryClient } from '@tanstack/react-query';

import type { ApiClient } from '../api/api-client';
import type { FragmentTokens } from '../features/auth/fragment-token';

export interface RouterContext {
    readonly queryClient: QueryClient;
    readonly apiClient: ApiClient;
    readonly fragmentTokens: FragmentTokens;
}
