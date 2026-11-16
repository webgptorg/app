import { activityPermission } from '@ptbk/engine-api';
import type { ActivityItem } from '@ptbk/engine-api';
import { Button, EmptyState, ErrorState, Section, Skeleton, useReducedMotion } from '@ptbk/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Activity as ActivityIcon, ArrowUp, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cx } from '../../../app/cx';
import { useEngineApi } from '../../../app/engine-api-context';
import { useVisibleFeatures } from '../../../app/registry/use-visible-features';
import { m } from '../../../paraglide/messages';
import { usePermissions } from '../../session/use-permissions';
import { visibleAreas } from './activity-areas';
import type { ActivityArea } from './activity-areas';
import { activitySummary, ActivityCard } from './activity-card';
import { activityId, activityKind, feedItems } from './activity-feed-cache';
import { createAnnouncer } from './activity-announcer';
import { activityFeedQueryOptions } from './activity-queries';

const route = getRouteApi('/');

const AREA_LABELS: Readonly<Record<ActivityArea, () => string>> = {
    run: m.activity_area_run,
    file: m.activity_area_file,
    trigger: m.activity_area_trigger,
    integration: m.activity_area_integration,
    member: m.activity_area_member,
    engine: m.activity_area_engine,
};

/** Home shows this many rows until the reader asks for all of it (or arrives filtered by area). */
export const RECENT_ACTIVITY_ROWS = 8;

const ENTER_SLIDE = 'animate-[ptbk-activity-enter_var(--motion-enter)_var(--ease-enter)]';
const ENTER_FADE = 'animate-[ptbk-activity-fade_var(--motion-enter)_linear]';

/**
 * The live activity feed: the first page from `GET /activity`, then whatever the event stream brings, on top and
 * without a refetch. Home shows the newest rows as "Recent activity"; "All activity" opens the whole feed in place,
 * with area filters and older pages. While the reader is scrolled into the feed, new items wait behind an "N new"
 * button instead of pushing the list down, and a polite live region sums them up at most once per 10 s.
 */
export function ActivityFeed() {
    const [opened, setOpened] = useState(false);
    const area = route.useSearch({ select: (search) => search.activity ?? null });
    const navigate = route.useNavigate();
    const features = useVisibleFeatures();
    const areas = visibleAreas(features);
    const { can } = usePermissions();
    const feed = useInfiniteQuery(activityFeedQueryOptions(useEngineApi(), area));
    // The engine filters by permission; this keeps a careless engine's items out of a member's view as well. Areas
    // this UI does not know are the engine's call.
    const items = feedItems(feed.data).filter((item) => {
        const permission = activityPermission(activityKind(item));
        return permission === null || can(permission);
    });
    const topId = items[0] === undefined ? null : activityId(items[0]);

    const arrivals = useArrivals(feed.data === undefined ? undefined : items, topId);
    const announcement = useAnnouncement(arrivals.latest, features);
    const reducedMotion = useReducedMotion();
    const { sentinelRef, heldFrom, release } = useHoldWhileAway(topId);
    const heldIndex = heldFrom === null ? -1 : items.findIndex((item) => activityId(item) === heldFrom);
    const current = heldIndex > 0 ? items.slice(heldIndex) : items;
    // A link to a filtered feed opens it whole.
    const expanded = opened || area !== null;
    const shown = expanded ? current : current.slice(0, RECENT_ACTIVITY_ROWS);
    // The way to filters and older pages, so it shows whenever there is any activity at all.
    const more = !expanded && items.length > 0;

    let content;
    if (feed.data === undefined && feed.isError) {
        content = (
            <ErrorState
                message={m.activity_failed()}
                onRetry={() => {
                    void feed.refetch();
                }}
                retrying={feed.isFetching}
            />
        );
    } else if (feed.data === undefined) {
        content = <FeedSkeleton />;
    } else if (items.length === 0) {
        content =
            area === null ? (
                <EmptyState
                    variant="inline"
                    icon={<ActivityIcon aria-hidden />}
                    title={m.activity_empty()}
                    description={m.activity_empty_body()}
                    headingLevel={3}
                />
            ) : (
                <p className="text-sm text-text-muted">{m.activity_empty_area()}</p>
            );
    } else {
        content = (
            <>
                {heldIndex > 0 ? (
                    <div className="sticky top-16 z-10 flex justify-center md:top-2">
                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                                release();
                            }}
                        >
                            <ArrowUp aria-hidden className="size-4" />
                            {m.activity_new_items({ count: heldIndex })}
                        </Button>
                    </div>
                ) : null}
                <ul className="flex flex-col divide-y divide-hairline border-y border-hairline">
                    {shown.map((item) => {
                        const id = activityId(item);
                        return (
                            <ActivityCard
                                key={id}
                                item={item}
                                features={features}
                                {...(arrivals.ids.has(id)
                                    ? { enterClassName: reducedMotion ? ENTER_FADE : ENTER_SLIDE }
                                    : {})}
                            />
                        );
                    })}
                </ul>
                {feed.isFetchNextPageError ? (
                    <ErrorState
                        message={m.activity_older_failed()}
                        onRetry={() => {
                            void feed.fetchNextPage();
                        }}
                        retrying={feed.isFetchingNextPage}
                    />
                ) : expanded && feed.hasNextPage ? (
                    <div className="flex justify-center pt-2">
                        <Button
                            variant="secondary"
                            loading={feed.isFetchingNextPage}
                            onClick={() => {
                                void feed.fetchNextPage();
                            }}
                        >
                            {m.activity_load_older()}
                        </Button>
                    </div>
                ) : null}
            </>
        );
    }

    return (
        <Section
            title={m.home_recent_activity()}
            className="min-w-0"
            {...(more
                ? {
                      actions: (
                          <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                  setOpened(true);
                              }}
                          >
                              {m.home_all_activity()}
                              <ChevronRight aria-hidden className="size-3.5" />
                          </Button>
                      ),
                  }
                : {})}
        >
            <div ref={sentinelRef} data-activity-top="" />
            {/* Filters once the whole feed is open and there is something to filter; a chosen area keeps them, so the
                way back stays. They wrap rather than scroll, so no area hides off the edge of a phone. */}
            {expanded && areas.length > 0 && (area !== null || items.length > 0) ? (
                <div role="group" aria-label={m.activity_filter_label()} className="flex flex-wrap gap-1">
                    {[null, ...areas].map((chip) => (
                        <button
                            key={chip ?? 'all'}
                            type="button"
                            aria-pressed={chip === area}
                            onClick={() => {
                                void navigate({ search: (previous) => ({ ...previous, activity: chip ?? undefined }) });
                            }}
                            className={cx(
                                'min-h-7 shrink-0 cursor-pointer rounded-pill px-2.5 text-xs font-medium',
                                'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                                chip === area
                                    ? 'bg-selected text-text'
                                    : 'text-text-muted hover:bg-hover hover:text-text',
                            )}
                        >
                            {chip === null ? m.activity_area_all() : AREA_LABELS[chip]()}
                        </button>
                    ))}
                </div>
            ) : null}
            {content}
            <p aria-live="polite" className="sr-only">
                {announcement}
            </p>
        </Section>
    );
}

function FeedSkeleton() {
    return (
        <ul aria-busy="true" className="flex flex-col divide-y divide-hairline">
            {[0, 1, 2, 3].map((row) => (
                <li key={row} className="flex items-center gap-3 py-3">
                    <Skeleton shape="circle" className="size-4" />
                    <Skeleton className="h-4 flex-1" />
                    <Skeleton className="h-4 w-16" />
                </li>
            ))}
        </ul>
    );
}

interface Arrivals {
    /** Every item that came in on top after the first page, so it animates in when it mounts. */
    readonly ids: ReadonlySet<string>;
    /** The newest batch, for the live region. */
    readonly latest: readonly ActivityItem[];
}

/**
 * What came in on top since the last render: everything above the item that was on top before. Older pages land at
 * the bottom and are not arrivals; a refetch that drops the previous top item announces nothing.
 */
function useArrivals(items: readonly ActivityItem[] | undefined, topId: string | null): Arrivals {
    const [state, setState] = useState<{ readonly top: string | null | undefined } & Arrivals>({
        top: undefined,
        ids: new Set(),
        latest: [],
    });
    if (items !== undefined && topId !== state.top) {
        const index =
            state.top === undefined || state.top === null
                ? -1
                : items.findIndex((item) => activityId(item) === state.top);
        const fresh = state.top === null ? items : index > 0 ? items.slice(0, index) : [];
        setState({
            top: topId,
            ids: fresh.length === 0 ? state.ids : new Set([...state.ids, ...fresh.map(activityId)]),
            latest: fresh,
        });
    }
    return state;
}

function useAnnouncement(latest: readonly ActivityItem[], features: Parameters<typeof activitySummary>[1]): string {
    const [text, setText] = useState('');
    const [announcer] = useState(() =>
        createAnnouncer({
            now: () => Date.now(),
            setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
            clearTimeout: (handle) => {
                globalThis.clearTimeout(handle as number);
            },
            announce: (lines) => {
                setText(lines.length === 1 ? (lines[0] ?? '') : m.activity_announce_many({ count: lines.length }));
            },
        }),
    );
    const featuresRef = useRef(features);
    useEffect(() => {
        featuresRef.current = features;
    });
    useEffect(() => {
        announcer.push(latest.map((item) => activitySummary(item, featuresRef.current)));
    }, [announcer, latest]);
    useEffect(
        () => () => {
            announcer.dispose();
        },
        [announcer],
    );
    return text;
}

/**
 * Whether the feed's top has scrolled out of view, and if so which item was on top then: everything newer waits
 * behind the "N new" button until the reader asks for it or scrolls back up.
 */
function useHoldWhileAway(topId: string | null) {
    const sentinelRef = useRef<HTMLDivElement>(null);
    const [heldFrom, setHeldFrom] = useState<string | null>(null);
    const topRef = useRef(topId);
    useEffect(() => {
        topRef.current = topId;
    });
    useEffect(() => {
        const onScroll = () => {
            const sentinel = sentinelRef.current;
            if (sentinel === null) return;
            const away = sentinel.getBoundingClientRect().top < 0;
            setHeldFrom((held) => (away ? (held ?? topRef.current) : null));
        };
        onScroll();
        // Capture, so a scrolling container anywhere above the feed counts as well as the window.
        window.addEventListener('scroll', onScroll, { capture: true, passive: true });
        return () => {
            window.removeEventListener('scroll', onScroll, { capture: true });
        };
    }, []);
    const release = () => {
        setHeldFrom(null);
        sentinelRef.current?.scrollIntoView({ block: 'start' });
    };
    return { sentinelRef, heldFrom, release };
}
