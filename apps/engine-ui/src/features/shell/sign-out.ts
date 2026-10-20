import { SIGN_IN_PATH, SIGN_OUT_PATH } from '@ptbk/engine-api';

import type { AppBrowser } from '../../app/browser-context';

/**
 * Ends the session at the engine's gateway, then leaves the app with a full-page navigation, so nothing of the
 * signed-in state stays in memory. Resolves false when the gateway could not be reached; the session is then intact.
 */
export async function signOut(browser: Pick<AppBrowser, 'fetch' | 'location'>): Promise<boolean> {
    try {
        const response = await browser.fetch(SIGN_OUT_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok && response.status !== 401) return false;
    } catch {
        return false;
    }
    browser.location.assign(SIGN_IN_PATH);
    return true;
}
