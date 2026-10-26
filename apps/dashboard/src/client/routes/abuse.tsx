import { createFileRoute } from '@tanstack/react-router';

import { AbusePage } from '../features/abuse/abuse-page';

/** Public: anyone who found an abusive engine must be able to read it, signed in or not (I-05). */
export const Route = createFileRoute('/abuse')({
    component: AbusePage,
});
