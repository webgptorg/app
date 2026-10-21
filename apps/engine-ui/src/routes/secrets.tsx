import { createFileRoute, stripSearchParams } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { DEFAULT_SECRET_SORT, secretListParams, SecretListSearch } from '../features/secrets/secret-list-search';
import { secretListQueryOptions } from '../features/secrets/secrets-queries';
import { SecretsPage } from '../features/secrets/secrets-page';

export const Route = createFileRoute('/secrets')({
    beforeLoad: requireFeature('secrets'),
    validateSearch: SecretListSearch,
    search: { middlewares: [stripSearchParams({ sort: DEFAULT_SECRET_SORT })] },
    loaderDeps: ({ search }) => secretListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads.
    loader: ({ context, deps }) => {
        context.queryClient.query(secretListQueryOptions(context.engineApi, deps)).catch(() => undefined);
    },
    component: SecretsPage,
});
