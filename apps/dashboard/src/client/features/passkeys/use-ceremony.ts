import { useCallback, useRef, useState } from 'react';

import type { CeremonyFailure, CeremonyResult } from './ceremonies';

export type CeremonyState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'running' }
    | { readonly kind: 'failed'; readonly failure: CeremonyFailure };

/**
 * Runs one passkey ceremony at a time and keeps its failure for the screen to explain, with the same button as the
 * retry. A second click while one runs is ignored: the authenticator would refuse a parallel prompt anyway.
 */
export function useCeremony<T>(
    ceremony: () => Promise<CeremonyResult<T>>,
    onSuccess: (value: T) => void | Promise<void>,
): { readonly state: CeremonyState; readonly start: () => void } {
    const [state, setState] = useState<CeremonyState>({ kind: 'idle' });
    const running = useRef(false);
    const start = useCallback(() => {
        if (running.current) {
            return;
        }
        running.current = true;
        setState({ kind: 'running' });
        void ceremony()
            .then(async (result) => {
                if (result.kind === 'ok') {
                    setState({ kind: 'idle' });
                    await onSuccess(result.value);
                } else {
                    setState({ kind: 'failed', failure: result.failure });
                }
            })
            .finally(() => {
                running.current = false;
            });
    }, [ceremony, onSuccess]);
    return { state, start };
}
