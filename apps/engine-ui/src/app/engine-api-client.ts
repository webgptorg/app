import { createFetchEngineApiClient } from '@ptbk/engine-api';
import type { EngineApiClient } from '@ptbk/engine-api';

export const ENGINE_API_TIMEOUT_MS = 30_000;

export interface EngineApiClientDeps {
    /** The engine's origin; the bundle is always served by the engine it talks to. */
    readonly origin: string;
    readonly fetch: typeof fetch;
}

export async function createAppEngineApiClient(deps: EngineApiClientDeps): Promise<EngineApiClient> {
    // Vite replaces `import.meta.env.DEV` with `false` in production builds, so this branch and the in-memory client
    // behind it are not in the bundle (a test looks for the client's marker in dist/).
    if (import.meta.env.DEV && import.meta.env.VITE_ENGINE_API === 'memory') {
        const { createDevEngineApiClient } = await import('./dev-engine-api-client');
        return createDevEngineApiClient();
    }
    return createFetchEngineApiClient({ baseUrl: deps.origin, fetch: deps.fetch, timeoutMs: ENGINE_API_TIMEOUT_MS });
}
