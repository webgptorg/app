import type { PreferenceStorage } from '@ptbk/ui';
import { useCallback, useState } from 'react';

import { useBrowser } from '../../app/browser-context';

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

export interface SidebarState {
    readonly collapsed: boolean;
    readonly toggle: () => void;
}

/** Held by the shell, so the sidebar's own button and the command palette change the same state. */
export function useSidebarState(): SidebarState {
    const { storage } = useBrowser();
    const [collapsed, setCollapsed] = useState(() => readSidebarCollapsed(storage));
    const toggle = useCallback(() => {
        setCollapsed((previous) => {
            persistSidebarCollapsed(storage, !previous);
            return !previous;
        });
    }, [storage]);
    return { collapsed, toggle };
}
