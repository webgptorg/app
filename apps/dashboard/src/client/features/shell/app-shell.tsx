import { SkipLink } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Outlet } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { m } from '../../../paraglide/messages';
import type { SessionView } from '../../../shared/api/routes';
import { sessionQuery } from '../../api/queries';
import { useApiClient } from '../../api/api-client-context';
import { Link } from '../../core/link';
import { SessionProvider } from '../session/use-session';
import { EnvironmentBadge } from './environment-badge';
import { HeaderLanguageSwitch } from './language-switch';
import { visibleNavEntries } from './navigation';
import { OrgSwitcher } from './org-switcher';
import { UserMenu } from './user-menu';

const MAIN_ID = 'main-content';

/**
 * The signed-in frame: header with the org name, navigation by capability and the user menu. It renders nothing once
 * the session is gone (sign-out, revocation), while the app is on its way to sign-in.
 */
export function AppShell() {
    const { data: session } = useQuery(sessionQuery(useApiClient()));
    if (session === undefined || session === null) {
        return null;
    }
    return (
        <AppFrame session={session}>
            <Outlet />
        </AppFrame>
    );
}

/** The frame on its own, for pages outside the `_app` layout that still belong to a signed-in person (not found). */
export function AppFrame({ session, children }: { readonly session: SessionView; readonly children: ReactNode }) {
    return (
        <SessionProvider session={session}>
            <div className="flex min-h-dvh flex-col bg-surface text-text">
                <SkipLink targetId={MAIN_ID} />
                <header className="border-b border-divider bg-raised">
                    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            {/* On a phone the wordmark gives way to the mark, so the org name keeps its room. */}
                            <img src="/favicon.svg" alt="" className="size-7 shrink-0 rounded-control sm:hidden" />
                            <span className="sr-only font-display text-lg font-semibold sm:not-sr-only">
                                {m.app_name()}
                            </span>
                            <span aria-hidden="true" className="hidden text-text-muted sm:inline">
                                /
                            </span>
                            <OrgSwitcher />
                            <EnvironmentBadge />
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <HeaderLanguageSwitch />
                            <UserMenu />
                        </div>
                        <nav aria-label={m.nav_main()} className="w-full">
                            <ul className="-mx-2 flex flex-wrap gap-1">
                                {visibleNavEntries(session).map((entry) => (
                                    <li key={entry.id}>
                                        <Link
                                            to={entry.to}
                                            variant="standalone"
                                            className="inline-flex items-center gap-2 rounded-control px-2 py-1.5 text-sm font-medium text-text-muted no-underline hover:bg-hover motion-safe:transition-colors motion-safe:duration-(--motion-state) aria-[current=page]:bg-selected aria-[current=page]:text-accent-text"
                                            activeProps={{ 'aria-current': 'page' }}
                                        >
                                            <entry.icon aria-hidden className="size-4" />
                                            {entry.label()}
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </nav>
                    </div>
                </header>
                <main
                    id={MAIN_ID}
                    tabIndex={-1}
                    className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 outline-none md:py-8"
                >
                    {children}
                </main>
            </div>
        </SessionProvider>
    );
}
