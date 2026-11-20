import { Button, STATUS_TINT_CLASSES } from '@ptbk/ui';
import { useMatchRoute } from '@tanstack/react-router';

import { cx } from '../../app/cx';
import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { whereLabel } from './browser-labels';
import type { LiveSession } from './live-session';
import { useLiveView } from './use-live-view';

/**
 * The shell's line while a session is live, on every page: whose browser, where, and whether the member is driving it,
 * with the way back to it and the way out. Gone once the session ends.
 */
export function LiveBrowserBar({ session }: { readonly session: LiveSession }) {
    const view = useLiveView(session);
    const onViewer = useMatchRoute()({ to: '/browser/$sessionId', params: { sessionId: session.id } }) !== false;
    if (view.endReason !== null) return null;
    const where = whereLabel(view.origin);
    const controlling = view.mode === 'controlling';
    let label = m.browser_bar_watching({ where });
    if (controlling) {
        label =
            view.session.kind === 'sign-in'
                ? m.browser_bar_signing_in({ where })
                : m.browser_bar_controlling({ where });
    }
    return (
        <div
            role="status"
            className={cx(
                'soft-surface mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm',
                STATUS_TINT_CLASSES[controlling ? 'live' : 'neutral'],
            )}
        >
            <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-pill bg-live motion-safe:animate-[ptbk-breathe_var(--motion-live)_var(--ease-standard)_infinite]"
            />
            <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{label}</span>
            <span className="flex shrink-0 items-center gap-1">
                {onViewer ? null : (
                    <ButtonLink to="/browser/$sessionId" params={{ sessionId: session.id }} size="sm" variant="ghost">
                        {m.browser_bar_open()}
                    </ButtonLink>
                )}
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                        void session.end();
                    }}
                >
                    {m.browser_bar_end()}
                </Button>
            </span>
        </div>
    );
}
