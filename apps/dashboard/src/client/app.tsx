import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';

import type { ApiClient } from './api/api-client';
import { ApiClientProvider } from './api/api-client-context';
import { LocaleProvider } from './i18n/locale';
import { createAppRouter } from './router';

/** Everything below `main.tsx`; tests render it with a fake {@link ApiClient}. */
export function App(props: { readonly apiClient: ApiClient }) {
    const [queryClient] = useState(() => new QueryClient());
    const [router] = useState(() => createAppRouter({ queryClient, apiClient: props.apiClient }));
    return (
        <ApiClientProvider client={props.apiClient}>
            <QueryClientProvider client={queryClient}>
                <LocaleProvider>
                    <RouterProvider router={router} />
                </LocaleProvider>
            </QueryClientProvider>
        </ApiClientProvider>
    );
}
