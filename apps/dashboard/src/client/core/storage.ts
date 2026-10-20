import type { PreferenceStorage } from '@ptbk/ui';

/**
 * `window.localStorage`, or `undefined` when the browser refuses access (blocked site data throws on the getter).
 * Every caller still guards each read and write: a quota or a revoked permission can throw later too.
 */
export function safeLocalStorage(): PreferenceStorage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}
