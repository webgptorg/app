import { createFileRoute } from '@tanstack/react-router';

import { WebsiteAccessPage } from '../../features/licensing/website-access-page';
import { websiteAccessErrorSchema, type WebsiteAccessError } from '../../../shared/api/routes';

interface WebsiteAccessSearch {
    /** Set by the return route only; anything else is dropped. */
    readonly error?: WebsiteAccessError;
}

/** Open signed in or not: the page signs in, signs up or links, as the pending website identity needs. */
export const Route = createFileRoute('/_auth/website-access')({
    validateSearch: (search: Readonly<Record<string, unknown>>): WebsiteAccessSearch => {
        const error = websiteAccessErrorSchema.safeParse(search['error']);
        return error.success ? { error: error.data } : {};
    },
    component: function WebsiteAccess() {
        return <WebsiteAccessPage error={Route.useSearch().error} />;
    },
});
