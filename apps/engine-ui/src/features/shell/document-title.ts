import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { engineInfoQueryOptions } from '../engine/engine-queries';

/** Before the engine's own name is known, and in the static HTML. */
const PRODUCT = 'Promptbook';

/**
 * Names the browser tab, history entry and screen reader page announcement (WCAG 2.4.2): the page first, then where
 * it lives, then the engine, e.g. "Runs · Ada · Dev engine". Every routed screen calls it once, next to its `h1`.
 */
export function useDocumentTitle(...segments: readonly string[]): void {
    // The root route prefetches the engine; this only reads that cache entry and never fetches on its own.
    const engine = useQuery({ ...engineInfoQueryOptions(useEngineApi()), enabled: false }).data;
    const title = [...segments, engine?.name ?? PRODUCT].filter((segment) => segment !== '').join(' · ');
    useEffect(() => {
        document.title = title;
    }, [title]);
}
