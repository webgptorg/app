import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PasskeyOutcome, WaitForPasskey } from './passkey-authenticator';

const cancelled = { kind: 'failed', reason: 'cancelled' } as const;

/** Only the browser prompt can be reopened. Options, verification and the caller's action stay single-flight. */
export function usePasskeyPrompt(enabled = true) {
    // A reply to an options request from a closed dialog must not open a prompt in a later instance.
    const owner = useMemo(() => (enabled ? Symbol() : null), [enabled]);
    const liveOwner = useRef(owner);
    const active = useRef<AbortController | null>(null);
    const [waiting, setWaiting] = useState(false);
    useEffect(() => {
        liveOwner.current = owner;
        return () => {
            liveOwner.current = null;
            active.current?.abort();
        };
    }, [owner]);

    const waitForPrompt: WaitForPasskey = useCallback(
        async <T>(open: (signal: AbortSignal) => Promise<PasskeyOutcome<T>>) => {
            if (owner === null || liveOwner.current !== owner) return cancelled;
            active.current?.abort();
            const controller = new AbortController();
            active.current = controller;
            setWaiting(true);
            // An extension can leave its promise pending even after receiving the native abort.
            const interrupted = new Promise<'reopen' | typeof cancelled>((resolve) => {
                controller.signal.addEventListener(
                    'abort',
                    () => {
                        resolve(controller.signal.reason === 'reopen' ? 'reopen' : cancelled);
                    },
                    { once: true },
                );
            });
            try {
                return await Promise.race([interrupted, open(controller.signal)]);
            } finally {
                if (active.current === controller) {
                    active.current = null;
                    setWaiting(false);
                }
            }
        },
        [owner],
    );
    const reopen = waiting ? () => active.current?.abort('reopen') : null;
    return { waitForPrompt, reopen };
}
