import { SkipLink } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { Outlet } from '@tanstack/react-router';

import { m } from '../../../paraglide/messages';
import { sessionQuery } from '../../api/queries';
import { useApiClient } from '../../api/api-client-context';
import { Link } from '../../core/link';
import { SessionProvider } from '../session/use-session';
import { EnvironmentBadge } from './environment-badge';
import { visibleNavEntries } from './navigation';
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
    const orgName = session.activeOrg.name ?? m.org_personal();
    return (
        <SessionProvider session={session}>
            <div className="flex min-h-dvh flex-col bg-surface text-text">
                <SkipLink targetId={MAIN_ID} />
                <header className="border-b border-divider bg-raised">
                    <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            <span className="font-display text-lg font-semibold">{m.app_name()}</span>
                            <span aria-hidden="true" className="text-text-muted">
                                /
                            </span>
                            <span className="truncate text-sm font-medium" title={orgName}>
                                {orgName}
                            </span>
                            <EnvironmentBadge />
                        </div>
                        <UserMenu />
                        <nav aria-label={m.nav_main()} className="w-full">
                            <ul className="-mx-2 flex flex-wrap gap-1">
                                {visibleNavEntries(session).map((entry) => (
                                    <li key={entry.id}>
                                        <Link
                                            to={entry.to}
                                            variant="standalone"
                                            activeOptions={{ exact: entry.to === '/' }}
                                            className="inline-flex items-center gap-2 rounded-control px-2 py-1.5 text-sm font-medium text-text-muted hover:bg-hover data-[status=active]:text-text"
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
                    <Outlet />
                </main>
            </div>
        </SessionProvider>
    );
}
