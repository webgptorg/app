import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { FilesPage } from '../features/files/files-page';
import { fileListQueryOptions } from '../features/files/files-queries';
import { fileListParams, FilesSearch } from '../features/files/files-search';

export const Route = createFileRoute('/files')({
    beforeLoad: requireFeature('files'),
    validateSearch: FilesSearch,
    loaderDeps: ({ search }) => fileListParams(search),
    // Not awaited: the table keeps the previous page on screen while the next one loads, and shows its own error.
    loader: ({ context, deps }) => {
        context.queryClient.query(fileListQueryOptions(context.engineApi, deps)).catch(() => undefined);
    },
    component: FilesPage,
});
