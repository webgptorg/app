import { EmptyState, Skeleton } from '@ptbk/ui';
import { SearchX } from 'lucide-react';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';

/** The engine answered 404 for this agent, or it was deleted. */
export function AgentNotFound() {
    return (
        <div className="py-8">
            <EmptyState
                icon={<SearchX aria-hidden />}
                title={m.agent_not_found_title()}
                description={m.agent_not_found_body()}
                headingLevel={1}
                action={
                    <Link to="/agents" variant="standalone">
                        {m.agent_not_found_back()}
                    </Link>
                }
            />
        </div>
    );
}

/** Shaped like the agent page (avatar, name, badges, tabs, a card), so it gives way without shifting the layout. */
export function AgentDetailPending() {
    return (
        <div aria-busy="true" className="flex flex-col gap-6">
            <span className="sr-only" role="status">
                {m.loading()}
            </span>
            <div className="flex items-start gap-4">
                <Skeleton shape="circle" className="size-14" />
                <div className="flex flex-1 flex-col gap-2">
                    <Skeleton shape="text" className="h-8 w-48" />
                    <Skeleton shape="text" className="h-4 w-full max-w-md" />
                    <Skeleton shape="text" className="h-5 w-32" />
                </div>
            </div>
            <Skeleton shape="block" className="h-10 w-full" />
            <Skeleton shape="block" className="h-48 w-full" />
        </div>
    );
}
