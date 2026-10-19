import { createContext, useContext, type ReactNode } from 'react';

import type { ApiClient } from './api-client';

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider(props: { readonly client: ApiClient; readonly children: ReactNode }) {
    return <ApiClientContext value={props.client}>{props.children}</ApiClientContext>;
}

export function useApiClient(): ApiClient {
    const client = useContext(ApiClientContext);
    if (client === null) {
        throw new Error('useApiClient needs an ApiClientProvider');
    }
    return client;
}
