import { useCallback, useSyncExternalStore } from 'react';

import { useBrowser } from '../../app/browser-context';

/** Below this width the sidebar becomes a drawer (Tailwind's `md` breakpoint, 768 px). */
export const NARROW_QUERY = '(max-width: 767.98px)';

export function useMediaQuery(query: string): boolean {
    const { matchMedia } = useBrowser();
    const subscribe = useCallback(
        (onChange: () => void) => {
            const list = matchMedia(query);
            list.addEventListener('change', onChange);
            return () => {
                list.removeEventListener('change', onChange);
            };
        },
        [matchMedia, query],
    );
    return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}
