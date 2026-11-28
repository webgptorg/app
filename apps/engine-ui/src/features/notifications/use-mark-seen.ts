import { MAX_NOTIFICATIONS_PER_SEEN, NotificationId } from '@ptbk/engine-api';
import type { ReadNotification } from '@ptbk/engine-api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { classifyApiError, unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { notificationKeys } from './notifications-queries';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Marks what the inbox shows as seen, one request of up to 100 IDs at a time, and puts the answered counts into the
 * badge. The list keeps its unseen look for this visit, so what was new stays findable. A 404 means an item closed in
 * the meantime: the inbox is read again and the rest marked; an ID refused twice is left alone, so an engine that
 * lists what it will not mark cannot make this loop.
 */
export function useMarkSeenOnView(items: readonly ReadNotification[] | undefined): void {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const sent = useRef(new Set<string>());
    const refusedOnce = useRef(new Set<string>());
    const { mutate, isPending } = useMutation({
        mutationFn: async (ids: readonly string[]) =>
            unwrap(
                await engineApi.notifications.markSeen(
                    { ids: ids.map((id) => NotificationId.parse(id)) },
                    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                ),
            ),
        onSuccess: (counts) => {
            queryClient.setQueryData(notificationKeys.counts(), counts);
        },
        onError: async (error, ids) => {
            const failure = classifyApiError(error);
            if (failure.kind !== 'problem' || failure.problem.status !== 404) return;
            for (const id of ids) {
                if (refusedOnce.current.has(id)) continue;
                refusedOnce.current.add(id);
                sent.current.delete(id);
            }
            // Awaited, so the next batch is picked from the fresh list rather than the one that held the closed item.
            await Promise.all([
                queryClient.refetchQueries({ queryKey: notificationKeys.inbox() }),
                queryClient.invalidateQueries({ queryKey: notificationKeys.counts() }),
            ]);
        },
    });
    useEffect(() => {
        if (items === undefined || isPending) return;
        const ids = items
            .filter((item) => item.seenAt === null && !sent.current.has(item.id))
            .slice(0, MAX_NOTIFICATIONS_PER_SEEN)
            .map((item) => item.id);
        if (ids.length === 0) return;
        for (const id of ids) sent.current.add(id);
        mutate(ids);
    }, [items, isPending, mutate]);
}
