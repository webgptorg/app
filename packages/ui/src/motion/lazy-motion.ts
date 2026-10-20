import type * as MotionReact from 'motion/react';
import { useEffect, useState } from 'react';

import { useReducedMotion } from './reduced-motion';

export type MotionModule = typeof MotionReact;

let pending: Promise<MotionModule> | undefined;

/**
 * Loads `motion` on first use, as its own chunk: it is only for choreography CSS cannot express, and never belongs in
 * an entry chunk (a test checks engine-ui's). It animates through the CSSOM, so it is CSP-safe.
 */
export function loadMotion(): Promise<MotionModule> {
    pending ??= import('motion/react');
    return pending;
}

/** The `motion` module once loaded, or `null` while loading and whenever the user prefers reduced motion. */
export function useMotion(): MotionModule | null {
    const reduced = useReducedMotion();
    const [module, setModule] = useState<MotionModule | null>(null);
    useEffect(() => {
        if (reduced) return;
        let active = true;
        void loadMotion().then((loaded) => {
            if (active) setModule(loaded);
        });
        return () => {
            active = false;
        };
    }, [reduced]);
    return reduced ? null : module;
}
