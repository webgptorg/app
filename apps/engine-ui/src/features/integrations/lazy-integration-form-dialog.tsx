import { lazy, Suspense } from 'react';

import type { IntegrationFormDialogProps } from './integration-form-dialog';

const IntegrationFormDialog = lazy(() =>
    import('./integration-form-dialog').then((module) => ({ default: module.IntegrationFormDialog })),
);

/** The form layer and pickers load when a member opens the dialog, not with the list or detail page. */
export function LazyIntegrationFormDialog(props: IntegrationFormDialogProps) {
    return (
        <Suspense fallback={null}>
            <IntegrationFormDialog {...props} />
        </Suspense>
    );
}
