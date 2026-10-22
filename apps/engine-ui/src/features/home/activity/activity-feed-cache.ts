import type { ActivityItem } from '@ptbk/engine-api';
import type { InfiniteData } from '@tanstack/react-query';

import { areaOf } from './activity-areas';
import type { ActivityArea } from './activity-areas';

/** Live items and loaded pages together never keep more than this in memory; older ones are fetched again on demand. */
export const MAX_FEED_ITEMS = 200;
export const FEED_PAGE_SIZE = 20;

/**
 * Where the next older page starts: the engine's cursor, or, once the cache was cut to `MAX_FEED_ITEMS`, the time of
 * the oldest item kept (the cursors of dropped pages point past items no longer held).
 */
export type FeedPageParam = { readonly cursor: string } | { readonly before: string } | null;

export interface FeedPage {
    readonly items: readonly ActivityItem[];
    readonly next: FeedPageParam;
}

export type FeedData = InfiniteData<FeedPage, FeedPageParam>;

export function activityId(item: ActivityItem): string {
    return item.kind === 'known' ? item.activity.id : item.base.id;
}

export function activityKind(item: ActivityItem): string {
    return item.kind === 'known' ? item.activity.kind : item.base.kind;
}

export function activityAt(item: ActivityItem): string {
    return item.kind === 'known' ? item.activity.at : item.base.at;
}

/** Every loaded item, newest first, each once: a page fetched from a time bound may repeat items at that instant. */
export function feedItems(data: Pick<FeedData, 'pages'> | undefined): ActivityItem[] {
    const seen = new Set<string>();
    const items: ActivityItem[] = [];
    for (const page of data?.pages ?? []) {
        for (const item of page.items) {
            const id = activityId(item);
            if (seen.has(id)) continue;
            seen.add(id);
            items.push(item);
        }
    }
    return items;
}

export function belongsToFeed(item: ActivityItem, area: ActivityArea | null): boolean {
    return area === null || areaOf(activityKind(item)) === area;
}

/**
 * Puts a live item on top of a cached feed, once. Past `MAX_FEED_ITEMS` the feed becomes one page of the newest items
 * whose "older" continues from the oldest one kept, so nothing between them is skipped.
 */
export function prependActivity(data: FeedData | undefined, item: ActivityItem): FeedData | undefined {
    const [first, ...rest] = data?.pages ?? [];
    if (data === undefined || first === undefined) return data;
    const id = activityId(item);
    if (data.pages.some((page) => page.items.some((existing) => activityId(existing) === id))) return data;
    const pages = [{ ...first, items: [item, ...first.items] }, ...rest];
    const total = pages.reduce((sum, page) => sum + page.items.length, 0);
    if (total <= MAX_FEED_ITEMS) return { ...data, pages };
    const kept = feedItems({ ...data, pages }).slice(0, MAX_FEED_ITEMS);
    const oldest = kept.at(-1);
    return {
        pages: [{ items: kept, next: oldest === undefined ? null : { before: justAfter(activityAt(oldest)) } }],
        pageParams: [data.pageParams[0] ?? null],
    };
}

/** `to` is exclusive; one millisecond later includes items at the same instant, which `feedItems` then drops. */
function justAfter(at: string): string {
    return new Date(Date.parse(at) + 1).toISOString();
}
