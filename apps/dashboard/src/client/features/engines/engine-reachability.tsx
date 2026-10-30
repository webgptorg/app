import { Unplug } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import type { EngineView } from '../../../shared/api/routes';

/** Whether there is anything to say: heartbeats prove an engine online, only the relays' reports prove it reachable. */
function hasReachability(engine: Pick<EngineView, 'status' | 'reachableRelays'>): boolean {
    return (engine.status === 'online' || engine.status === 'owner-pending') && engine.reachableRelays !== null;
}

/**
 * Through how many relays browsers reach an online engine (R-07). Nothing while no relay reports, so an engine is never
 * called unreachable on missing data.
 */
export function EngineReachability(props: { readonly engine: Pick<EngineView, 'status' | 'reachableRelays'> }) {
    const { reachableRelays } = props.engine;
    if (!hasReachability(props.engine) || reachableRelays === null) {
        return null;
    }
    if (reachableRelays > 0) {
        return <span className="text-sm text-text-muted">{m.engines_reachable({ count: reachableRelays })}</span>;
    }
    return (
        <span className="inline-flex items-center gap-1 text-sm">
            <Unplug aria-hidden className="size-4 shrink-0 text-warning" />
            {m.engines_not_reachable()}
        </span>
    );
}
