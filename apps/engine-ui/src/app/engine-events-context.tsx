import { createContext, use, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import type { EngineEventSubscriber, EngineEvents } from './engine-events';

const EngineEventsContext = createContext<EngineEvents | null>(null);

export function EngineEventsProvider({
    events,
    children,
}: {
    readonly events: EngineEvents;
    readonly children: ReactNode;
}) {
    return <EngineEventsContext value={events}>{children}</EngineEventsContext>;
}

/** Listens to the app-wide engine event stream while the calling component is mounted. */
export function useEngineEvents(subscriber: EngineEventSubscriber): void {
    const events = use(EngineEventsContext);
    if (events === null) throw new Error('useEngineEvents() needs an <EngineEventsProvider> above it');
    const latest = useRef(subscriber);
    useEffect(() => {
        latest.current = subscriber;
    });
    useEffect(
        () =>
            events.subscribe({
                onEvent: (event) => {
                    latest.current.onEvent(event);
                },
                onReconnect: () => {
                    latest.current.onReconnect?.();
                },
            }),
        [events],
    );
}
