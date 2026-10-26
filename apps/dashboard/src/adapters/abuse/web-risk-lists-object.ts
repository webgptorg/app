import { DurableObject } from 'cloudflare:workers';

import { createWebRiskStore, type ThreatListUpdate, type WebRiskStore, type WebRiskThreatType } from './web-risk-store';

/** The one `WebRiskStore` (I-08), named `web-risk`: Web Risk's threat lists in the object's storage. */
export class WebRiskListsObject extends DurableObject {
    #store: WebRiskStore | undefined;

    #get(): WebRiskStore {
        this.#store ??= createWebRiskStore(this.ctx.storage);
        return this.#store;
    }

    versions() {
        return this.#get().versions();
    }

    apply(threatType: WebRiskThreatType, update: ThreatListUpdate, at: number) {
        return this.#get().apply(threatType, update, at);
    }

    prefixHits(fullHashes: readonly Uint8Array[]) {
        return this.#get().prefixHits(fullHashes);
    }

    cachedSearches(prefixes: readonly Uint8Array[]) {
        return this.#get().cachedSearches(prefixes);
    }

    cacheSearches(results: Parameters<WebRiskStore['cacheSearches']>[0], at: number) {
        return this.#get().cacheSearches(results, at);
    }
}
