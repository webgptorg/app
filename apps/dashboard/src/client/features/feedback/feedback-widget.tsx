import { useEffect, useEffectEvent } from 'react';

import { useSession } from '../session/use-session';
import type { FeedbackSender } from './feedback';
import { feedbackEndpoint, underAutomation } from './feedback-gate';

/**
 * ucho, Contember's feedback widget: a launcher that sends a message and an annotated screenshot of this page to
 * clientcare. Loaded on demand, so the entry bundle stays as it was; renders nothing itself (ucho mounts its own
 * shadow root on `<body>`).
 */
export function FeedbackWidget({
    project = import.meta.env.VITE_UCHO_PROJECT,
}: {
    readonly project?: string | undefined;
}) {
    const session = useSession();
    // Read at submit time, so switching orgs updates the sender without re-initialising the widget.
    const currentSender = useEffectEvent((): FeedbackSender => ({
        email: session.user.email,
        userId: session.user.id,
        orgId: session.activeOrg.id,
    }));

    useEffect(() => {
        const endpoint = feedbackEndpoint(project);
        if (endpoint === null || underAutomation(globalThis.navigator)) {
            return;
        }
        let cleanup: (() => void) | undefined;
        let unmounted = false;
        void import('./feedback').then(({ init, feedbackConfig }) => {
            if (!unmounted) {
                cleanup = init(feedbackConfig(endpoint, () => currentSender()));
            }
        });
        return () => {
            unmounted = true;
            cleanup?.();
        };
    }, [project]);

    return null;
}
