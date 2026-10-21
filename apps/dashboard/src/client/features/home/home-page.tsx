import { EmptyState } from '@ptbk/ui';
import { Server } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { Link } from '../../core/link';
import { useSession } from '../session/use-session';

/** Home of the signed-in dashboard; the engine list (D-06) replaces the empty state. */
export function HomePage() {
    const session = useSession();
    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.home_title()}</h1>
            <EmptyState
                icon={<Server aria-hidden />}
                title={m.home_empty_title()}
                description={m.home_empty_body()}
                {...(session.activeOrg.permissions.includes('engine.link')
                    ? { action: <Link to="/engines/new">{m.home_add_engine()}</Link> }
                    : {})}
            />
        </div>
    );
}
