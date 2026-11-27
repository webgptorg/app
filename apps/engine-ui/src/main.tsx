import './app/zod-jitless';
import './styles/app.css';

import { applyTheme, readThemePreference } from '@ptbk/ui';

import { bootstrap } from './app/bootstrap';
import { safeLocalStorage } from './app/storage';
import { createWindowStepUpPopups } from './features/step-up/step-up-popup';

const storage = safeLocalStorage();
const matchMedia = (query: string) => window.matchMedia(query);
// The CSP allows no inline script in index.html, so this is the earliest point to set the theme; it runs before React
// renders anything, so the first paint is already in the right theme.
applyTheme(readThemePreference(storage), document.documentElement, matchMedia);

document.documentElement.dataset['uiVersion'] = __PTBK_UI_VERSION__;

// The browser fetches a web font only once text needs it, after the route's chunks and data: on a busy engine Inter
// then swaps in under text already drawn in its fallback, and a long thread rewraps by hundreds of pixels. Asked for
// now, while the app is still starting, the fonts are there before any text is. The sample covers Czech's letters too.
for (const family of ['Inter Variable', 'JetBrains Mono Variable']) {
    void document.fonts.load(`1em "${family}"`, 'Aa čřšžůě').catch(() => undefined);
}

const container = document.getElementById('root');
if (container === null) {
    throw new Error('index.html has no #root element');
}
// No top-level await: it would turn off Rolldown's merging of common chunks into the entry, which keeps zod-jitless
// running before any schema is built and index.html down to one script.
void bootstrap(container, {
    document,
    location: window.location,
    fetch: (input, init) => fetch(input, init),
    cspScope: window,
    storage,
    matchMedia,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    popups: createWindowStepUpPopups(window),
});
