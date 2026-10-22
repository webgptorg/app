import { RelativeTime } from '@ptbk/ui';
import { useState } from 'react';

import { m } from '../../../paraglide/messages';
import type { EngineView } from '../../../shared/api/routes';
import { useBrowser } from '../../core/browser';

/** The injected clock's time, taken again whenever `key` changes (a refetch), so relative times move with the data. */
export function useNowFor(key: unknown): Date {
    const { now } = useBrowser();
    const [snapshot, setSnapshot] = useState(() => ({ key, at: new Date(now()) }));
    if (!Object.is(snapshot.key, key)) {
        const next = { key, at: new Date(now()) };
        setSnapshot(next);
        return next.at;
    }
    return snapshot.at;
}

/** A value the engine has not reported (no heartbeat yet, or its status could not be read). */
export function NotReported() {
    return (
        <>
            <span aria-hidden="true" className="text-text-muted">
                {'—'}
            </span>
            <span className="sr-only">{m.engines_not_reported()}</span>
        </>
    );
}

/** Relative, with the exact time on hover; "never" only when we know there was no heartbeat. */
export function LastSeen(props: { readonly engine: Pick<EngineView, 'lastSeenAt' | 'status'>; readonly now: Date }) {
    const { lastSeenAt, status } = props.engine;
    if (lastSeenAt !== null) {
        return <RelativeTime value={new Date(lastSeenAt)} now={props.now} />;
    }
    return status === 'unknown' ? <NotReported /> : <span>{m.engines_never()}</span>;
}
