import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { memberListParams, MemberListSearch } from '../features/members/member-list-search';
import { memberListQueryOptions } from '../features/members/members-queries';
import { MembersPage } from '../features/members/members-page';

export const Route = createFileRoute('/members')({
    beforeLoad: requireFeature('members'),
    validateSearch: MemberListSearch,
    loaderDeps: ({ search }) => memberListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads.
    loader: ({ context, deps }) => {
        context.queryClient.query(memberListQueryOptions(context.engineApi, deps)).catch(() => undefined);
    },
    component: MembersPage,
});
