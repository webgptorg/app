import { createFileRoute } from '@tanstack/react-router';

import { NewEnginePage } from '../../../features/engines/new-engine-page';

export const Route = createFileRoute('/_app/engines/new')({
    component: NewEnginePage,
});
