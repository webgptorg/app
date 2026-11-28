import { BrandLockup, BrandMark, SkipLink } from '@ptbk/ui';
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
                <header className="sticky top-0 z-20 border-b border-hairline bg-[color-mix(in_oklab,var(--color-surface)_88%,transparent)] backdrop-blur-md">
                    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 px-4 md:h-12 md:flex-nowrap">
                        <div className="flex h-12 min-w-0 flex-1 items-center gap-2 md:flex-none">
                            <Link to="/" variant="standalone" aria-label="Promptbook">
                                <BrandMark decorative className="sm:hidden" />
                                <BrandLockup decorative className="hidden sm:block" />
                            </Link>
                            <span aria-hidden="true" className="hidden text-text-subtle sm:inline">
                                /
                            </span>
                            <OrgSwitcher />
                            <EnvironmentBadge />
                        </div>
                        {/* One nav landmark: beside the brand on wide screens, its own scrolling row on a phone. */}
                        <nav
                            aria-label={m.nav_main()}
                            className="order-last -mx-4 w-[calc(100%+2rem)] overflow-x-auto px-2 pb-1.5 md:order-none md:mx-0 md:w-auto md:flex-1 md:overflow-visible md:p-0"
                        >
                            <ul className="flex gap-0.5">
                                {visibleNavEntries(session).map((entry) => (
                                    <li key={entry.id} className="shrink-0">
                                        <Link
                                            to={entry.to}
                                            variant="standalone"
                                            className="inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 text-sm text-text-muted no-underline hover:bg-hover hover:text-text motion-safe:transition-colors motion-safe:duration-(--motion-state) aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-text"
                                            activeProps={{ 'aria-current': 'page' }}
                                        >
                                            <entry.icon aria-hidden className="hidden size-4 opacity-80 lg:block" />
                                            {entry.label()}
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </nav>
                        <div className="flex h-12 shrink-0 items-center gap-0.5">
                            <HeaderLanguageSwitch />
                            <UserMenu />
                        </div>
                    </div>
                </header>
                <main
                    id={MAIN_ID}
                    tabIndex={-1}
                    className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 outline-none md:py-10"
                >
                    {children}
                </main>
            </div>
        </SessionProvider>
    );
}
