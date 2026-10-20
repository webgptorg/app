import type { PreferenceStorage } from '@ptbk/ui';

export const SIDEBAR_STORAGE_KEY = 'ptbk.sidebar';

/** Whether the desktop sidebar shows icons only; per device, and expanded when storage refuses to answer. */
export function readSidebarCollapsed(storage: PreferenceStorage | undefined): boolean {
    try {
        return storage?.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed';
    } catch {
        return false;
    }
}

export function persistSidebarCollapsed(storage: PreferenceStorage | undefined, collapsed: boolean): void {
    try {
        storage?.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
    } catch {
        // Still applies to this page; it just will not survive a reload.
    }
}
