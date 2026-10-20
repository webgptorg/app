import { EmptyState } from '@ptbk/ui';
import { ShieldCheck } from 'lucide-react';

import { m } from '../../../paraglide/messages';

/** `/admin`: the platform admin area; its tools arrive with D-07, D-08 and I-05. */
export function AdminPage() {
    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.admin_title()}</h1>
            <EmptyState
                icon={<ShieldCheck aria-hidden />}
                title={m.admin_empty_title()}
                description={m.admin_empty_body()}
            />
        </div>
    );
}
