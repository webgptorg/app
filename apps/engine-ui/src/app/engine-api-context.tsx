import type { EngineApiClient } from '@ptbk/engine-api';
import { createContext, use } from 'react';
import type { ReactNode } from 'react';

const EngineApiContext = createContext<EngineApiClient | null>(null);

export function EngineApiProvider({
    client,
    children,
}: {
    readonly client: EngineApiClient;
    readonly children: ReactNode;
}) {
    return <EngineApiContext value={client}>{children}</EngineApiContext>;
}

export function useEngineApi(): EngineApiClient {
    const client = use(EngineApiContext);
    if (client === null) {
        throw new Error('useEngineApi() needs an <EngineApiProvider> above it');
    }
    return client;
}
