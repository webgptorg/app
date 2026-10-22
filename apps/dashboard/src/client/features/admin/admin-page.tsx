import { Card } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { Link } from '../../core/link';
import { EngineLookupCard } from './hostnames/engine-lookup-card';

/** `/admin`: the platform admin area; custom domains (D-08) and abuse tools (I-05) add their entries here. */
export function AdminPage() {
    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.admin_title()}</h1>
            <Card title={m.admin_tools_title()}>
                <ul className="flex flex-col gap-2">
                    <li className="flex flex-col gap-1">
                        <Link to="/admin/billing">{m.admin_billing_title()}</Link>
                        <span className="text-sm text-text-muted">{m.admin_billing_summary()}</span>
                    </li>
                </ul>
            </Card>
            <EngineLookupCard />
        </div>
    );
}
