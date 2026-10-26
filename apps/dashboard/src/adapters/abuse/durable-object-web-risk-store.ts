import type { WebRiskStore } from './web-risk-store';

export interface WebRiskListsNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): WebRiskStore;
}

/** The one instance, by a fixed name: every run reads and updates the same lists. */
export const WEB_RISK_LISTS_NAME = 'web-risk';

export function createDurableObjectWebRiskStore(namespace: WebRiskListsNamespace): WebRiskStore {
    const stub = () => namespace.get(namespace.idFromName(WEB_RISK_LISTS_NAME));
    return {
        versions: () => stub().versions(),
        apply: (threatType, update, at) => stub().apply(threatType, update, at),
        prefixHits: (fullHashes) => stub().prefixHits(fullHashes),
        cachedSearches: (prefixes) => stub().cachedSearches(prefixes),
        cacheSearches: (results, at) => stub().cacheSearches(results, at),
    };
}
