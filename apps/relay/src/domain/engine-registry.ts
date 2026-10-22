import type { EngineId, RegistryEntry } from '@ptbk/protocol';

export type RegistryLookup =
    | { readonly kind: 'found'; readonly entry: RegistryEntry }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'unavailable' };

export interface LookupOptions {
    /** Ask the source even if a cached answer is still fresh; adapters always ask it. */
    readonly fresh?: boolean;
}

/**
 * Looked up by engine ID at tunnel auth and revalidation only; nothing looks engines up by hostname. Adapters hold no
 * cache: every one is wrapped by `createCachedRegistry`.
 */
export interface EngineRegistry {
    /** Rejects with `signal.reason` once `signal` aborts; a registry that cannot answer is `unavailable`. */
    lookup(engineId: EngineId, signal: AbortSignal, options?: LookupOptions): Promise<RegistryLookup>;
}
