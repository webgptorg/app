import type { PreferenceStorage } from '@ptbk/ui';

import type { OwnerSetupStorage } from '../features/engines/owner-handoff';

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

/** `window.sessionStorage`, guarded the same way. */
export function safeSessionStorage(): OwnerSetupStorage | undefined {
    try {
        return window.sessionStorage;
    } catch {
        return undefined;
    }
}
