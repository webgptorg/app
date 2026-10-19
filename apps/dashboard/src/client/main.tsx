import './zod-jitless';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createApiClient } from './api/api-client';
import { App } from './app';

const container = document.getElementById('root');
if (container === null) {
    throw new Error('index.html has no #root element');
}

createRoot(container).render(
    <StrictMode>
        <App apiClient={createApiClient({ fetch: (input, init) => fetch(input, init) })} />
    </StrictMode>,
);
