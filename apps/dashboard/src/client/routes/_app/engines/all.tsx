import { createFileRoute } from '@tanstack/react-router';

import { EngineListPage } from '../../../features/engines/engine-list-page';

export const Route = createFileRoute('/_app/engines/all')({
    component: EngineListPage,
});
