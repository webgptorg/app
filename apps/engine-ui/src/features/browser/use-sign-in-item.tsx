import type { MenuEntry } from '@ptbk/ui';
import { MonitorUp } from 'lucide-react';

import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { CONTROL_REQUIREMENT } from './browser-queries';
import { signInOrigin, useOpenSignIn } from './use-browser-actions';

/**
 * "Sign in in the engine's browser" for a site's menu: a fresh tab there for the owner alone, behind step-up. Absent
 * without `browser-tab@1` or `browser.control`, and for a site that is not https. The engine decides whether the
 * site is on its sign-in allowlist.
 */
export function useSignInItems(origin: string): readonly MenuEntry[] {
    const allowed = useAllows(CONTROL_REQUIREMENT);
    const open = useOpenSignIn();
    const site = signInOrigin(origin);
    if (!allowed || site === null) return [];
    return [
        {
            kind: 'item',
            id: 'browser-sign-in',
            label: m.browser_sign_in_here(),
            icon: <MonitorUp />,
            disabled: open.isPending,
            onSelect: () => {
                open.mutate({ origin: site });
            },
        },
        { kind: 'separator', id: 'browser-sign-in-separator' },
    ];
}
