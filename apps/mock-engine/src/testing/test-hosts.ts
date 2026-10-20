import type { LookupFunction } from 'node:net';

import type { RelayLinkState } from '../domain/tunnel/relay-link';

/** Resolves every name to 127.0.0.1, so tests can dial `relay-a.ptbk.test` and verify its certificate by name. */
export const lookupLoopback: LookupFunction = (_hostname, options, callback) => {
    if (options.all === true) {
        (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, [
            { address: '127.0.0.1', family: 4 },
        ]);
        return;
    }
    callback(null, '127.0.0.1', 4);
};

type Kind = RelayLinkState['kind'];

/** Tracks link states by relay and lets a test await the next state of a kind, without polling or sleeping. */
export interface LinkStates {
    readonly onLinkState: (relay: { readonly relayId: string }, state: RelayLinkState) => void;
    latest(relayId: string): RelayLinkState | undefined;
    /** Resolves with the first state of one of `kinds` reached after now (or the current one if it matches). */
    next(relayId: string, ...kinds: Kind[]): Promise<RelayLinkState>;
}

export function trackLinkStates(): LinkStates {
    const latest = new Map<string, RelayLinkState>();
    const waiters = new Set<{ relayId: string; kinds: Kind[]; resolve: (state: RelayLinkState) => void }>();
    return {
        onLinkState(relay, state) {
            latest.set(relay.relayId, state);
            for (const waiter of [...waiters]) {
                if (waiter.relayId === relay.relayId && waiter.kinds.includes(state.kind)) {
                    waiters.delete(waiter);
                    waiter.resolve(state);
                }
            }
        },
        latest: (relayId) => latest.get(relayId),
        next(relayId, ...kinds) {
            const current = latest.get(relayId);
            if (current !== undefined && kinds.includes(current.kind)) return Promise.resolve(current);
            return new Promise((resolve) => waiters.add({ relayId, kinds, resolve }));
        },
    };
}
