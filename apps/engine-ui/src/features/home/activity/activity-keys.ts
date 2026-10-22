import type { ActivityArea } from './activity-areas';

/** The feed, per area filter (`null` for all); live events go into every cached feed they belong to. */
export const activityKeys = {
    all: ['activity'] as const,
    feeds: () => [...activityKeys.all, 'feed'] as const,
    feed: (area: ActivityArea | null) => [...activityKeys.feeds(), area] as const,
};
