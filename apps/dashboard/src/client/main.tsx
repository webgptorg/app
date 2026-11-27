import './zod-jitless';
import './styles.css';

import { applyTheme, readThemePreference } from '@ptbk/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createApiClient } from './api/api-client';
import { App } from './app';
import { safeLocalStorage, safeSessionStorage } from './core/storage';
import { createBrowserPasskeyAuthenticator } from './features/passkeys/browser-passkey-authenticator';

const storage = safeLocalStorage();
const matchMedia = (query: string) => window.matchMedia(query);
// The CSP allows no inline script in index.html, so this is the earliest point to set the theme; it runs before React
// renders anything, so the first paint is already in the right theme.
applyTheme(readThemePreference(storage), document.documentElement, matchMedia);

const container = document.getElementById('root');
if (container === null) {
    throw new Error('index.html has no #root element');
}

createRoot(container).render(
    <StrictMode>
        <App
            apiClient={createApiClient({ fetch: (input, init) => fetch(input, init) })}
            browser={{
                storage,
                sessionStorage: safeSessionStorage(),
                matchMedia,
                passkeys: createBrowserPasskeyAuthenticator(),
                now: () => Date.now(),
                origin: window.location.origin,
                navigate: (url) => {
                    window.location.assign(url);
                },
            }}
        />
    </StrictMode>,
);
