import type { Hostname } from '@ptbk/protocol';

import type { AbuseFeed } from '../domain/abuse/abuse-feed';

export interface FakeAbuseFeed extends AbuseFeed {
    readonly listing: Set<string>;
    fail: Error | null;
    readonly batches: number[];
}

/** A feed that lists what `listing` holds. */
export function createFakeAbuseFeed(name: string): FakeAbuseFeed {
    const feed: FakeAbuseFeed = {
        name,
        listing: new Set(),
        fail: null,
        batches: [],
        listed(hostnames) {
            feed.batches.push(hostnames.length);
            if (feed.fail !== null) return Promise.reject(feed.fail);
            return Promise.resolve(new Set<Hostname>(hostnames.filter((hostname) => feed.listing.has(hostname))));
        },
    };
    return feed;
}
