import type { Activity, ActivityItem } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { activityId, belongsToFeed, feedItems, MAX_FEED_ITEMS, prependActivity } from './activity-feed-cache';
import type { FeedData } from './activity-feed-cache';

const START = Date.parse('2026-10-01T12:00:00.000Z');

/** Item `n` happened `n` seconds after START, so higher is newer. */
function item(n: number, kind = 'run.started'): ActivityItem {
    return {
        kind: 'known',
        activity: {
            kind,
            v: 1,
            id: `activity-${String(n)}`,
            at: new Date(START + n * 1000).toISOString(),
            agentId: null,
            agentName: null,
            actor: { kind: 'system' },
        } as unknown as Activity,
    };
}

function pages(...ranges: (readonly [number, number])[]): FeedData {
    return {
        pages: ranges.map(([from, to], index) => ({
            items: Array.from({ length: from - to + 1 }, (_, offset) => item(from - offset)),
            next: index === ranges.length - 1 ? null : { cursor: `cursor-${String(index + 1)}` },
        })),
        pageParams: ranges.map((_, index) => (index === 0 ? null : { cursor: `cursor-${String(index)}` })),
    };
}

describe('the activity feed cache', () => {
    it('puts a live item on top of the first page, once', () => {
        const data = pages([10, 1]);
        const next = prependActivity(data, item(11));
        expect(feedItems(next).map(activityId).slice(0, 2)).toEqual(['activity-11', 'activity-10']);
        expect(prependActivity(next, item(11))).toBe(next);
        expect(prependActivity(next, item(5))).toBe(next);
    });

    it('leaves a feed that is not loaded alone', () => {
        expect(prependActivity(undefined, item(1))).toBeUndefined();
    });

    it(`keeps the newest ${String(MAX_FEED_ITEMS)} and continues "older" from the oldest one kept`, () => {
        const data = pages([MAX_FEED_ITEMS, 101], [100, 1]);
        const next = prependActivity(data, item(MAX_FEED_ITEMS + 1));
        const items = feedItems(next);
        expect(items).toHaveLength(MAX_FEED_ITEMS);
        expect(activityId(items[0] as ActivityItem)).toBe(`activity-${String(MAX_FEED_ITEMS + 1)}`);
        expect(activityId(items.at(-1) as ActivityItem)).toBe('activity-2');
        expect(next?.pages).toHaveLength(1);
        expect(next?.pages[0]?.next).toEqual({ before: new Date(START + 2 * 1000 + 1).toISOString() });
        expect(next?.pageParams).toEqual([null]);
    });

    it('lists each item once even when a page repeats an item at the boundary', () => {
        const data: FeedData = {
            pages: [
                { items: [item(3), item(2)], next: { before: 'x' } },
                { items: [item(2), item(1)], next: null },
            ],
            pageParams: [null, { before: 'x' }],
        };
        expect(feedItems(data).map(activityId)).toEqual(['activity-3', 'activity-2', 'activity-1']);
    });

    it('sorts items into the feed of their area, and every item into the unfiltered one', () => {
        expect(belongsToFeed(item(1, 'run.failed'), 'run')).toBe(true);
        expect(belongsToFeed(item(1, 'file.created'), 'run')).toBe(false);
        expect(belongsToFeed(item(1, 'deploy.started'), null)).toBe(true);
    });
});
