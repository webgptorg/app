import { Card } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { Link } from '../../core/link';
import { useSession } from '../session/use-session';
import { EngineLookupCard } from './hostnames/engine-lookup-card';

/** `/admin`: the platform admin area; engines (suspension, I-05, and custom domains, D-08) are found by ID below. */
export function AdminPage() {
    const session = useSession();
    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.admin_title()}</h1>
            {/* Billing is the only tool so far; with billing off there is nothing to list. */}
            {session.billingEnabled ? (
                <Card title={m.admin_tools_title()}>
                    <ul className="flex flex-col gap-2">
                        <li className="flex flex-col gap-1">
                            <Link to="/admin/billing">{m.admin_billing_title()}</Link>
                            <span className="text-sm text-text-muted">{m.admin_billing_summary()}</span>
                        </li>
                    </ul>
                </Card>
            ) : null}
            <EngineLookupCard />
        </div>
    );
}
