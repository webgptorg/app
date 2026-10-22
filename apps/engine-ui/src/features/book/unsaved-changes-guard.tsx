import { ConfirmDialog } from '@ptbk/ui';
import { useBlocker } from '@tanstack/react-router';

import { m } from '../../paraglide/messages';

export interface UnsavedChangesGuardProps {
    /** Unsaved work would be lost by leaving the page. */
    readonly when: boolean;
}

/**
 * Asks before leaving a page with unsaved work, inside the app and on reload or close. Moving within the same page
 * (a wizard step in the search params) is not leaving it. Nothing is kept in browser storage, so leaving loses it.
 */
export function UnsavedChangesGuard({ when }: UnsavedChangesGuardProps) {
    const blocker = useBlocker({
        shouldBlockFn: ({ current, next }) => when && current.pathname !== next.pathname,
        enableBeforeUnload: () => when,
        withResolver: true,
    });
    return (
        <ConfirmDialog
            open={blocker.status === 'blocked'}
            onClose={() => blocker.reset?.()}
            onConfirm={() => blocker.proceed?.()}
            title={m.unsaved_title()}
            description={m.unsaved_body()}
            confirmLabel={m.unsaved_leave()}
            tone="danger"
        />
    );
}
