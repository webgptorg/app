import { EmptyState, Skeleton } from '@ptbk/ui';
import { SearchX } from 'lucide-react';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';

/** The engine answered 404 for this thread. */
export function ChatNotFound() {
    return (
        <div className="py-8">
            <EmptyState
                icon={<SearchX aria-hidden />}
                title={m.chat_not_found_title()}
                description={m.chat_not_found_body()}
                headingLevel={2}
                action={
                    <Link to="/chats" variant="standalone">
                        {m.chat_back()}
                    </Link>
                }
            />
        </div>
    );
}

/** Shaped like a chat (title, a few messages, the composer), so it gives way without shifting the layout. */
export function ChatPending() {
    return (
        <div aria-busy="true" className="flex flex-col gap-4">
            <span className="sr-only" role="status">
                {m.loading()}
            </span>
            <Skeleton shape="text" className="h-7 w-64" />
            <MessagesSkeleton />
            <Skeleton shape="block" className="h-28 w-full" />
        </div>
    );
}

export function MessagesSkeleton() {
    return (
        <div aria-hidden="true" className="flex flex-col gap-4">
            <Skeleton shape="block" className="h-16 w-2/3" />
            <Skeleton shape="block" className="ms-auto h-12 w-1/2" />
            <Skeleton shape="block" className="h-24 w-3/4" />
        </div>
    );
}
