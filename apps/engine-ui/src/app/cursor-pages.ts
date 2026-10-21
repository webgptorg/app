import type { DataTablePage } from '@ptbk/ui';
import { useState } from 'react';

/** The previous-page cursor that means "the first page", which has no cursor of its own. */
const FIRST_PAGE = '';

export interface CursorPages {
    readonly page: DataTablePage;
    readonly onPageChange: (cursor: string, direction: 'previous' | 'next') => void;
}

/**
 * Cursor paging for a server-side `DataTable` whose cursor lives in the URL. Cursors only lead forward, so this
 * remembers where each visited page came from; after a reload "previous" goes back to the first page.
 */
export function useCursorPages(
    cursor: string | undefined,
    nextCursor: string | null,
    navigate: (cursor: string | undefined) => void,
): CursorPages {
    const [previousCursors, setPreviousCursors] = useState<ReadonlyMap<string, string>>(() => new Map());
    return {
        page: {
            previousCursor: cursor === undefined ? null : (previousCursors.get(cursor) ?? FIRST_PAGE),
            nextCursor,
        },
        onPageChange: (target, direction) => {
            // A second click before the next page arrives would make the page its own predecessor.
            if (target === cursor) return;
            if (direction === 'next') setPreviousCursors((known) => new Map(known).set(target, cursor ?? FIRST_PAGE));
            navigate(target === FIRST_PAGE ? undefined : target);
        },
    };
}
