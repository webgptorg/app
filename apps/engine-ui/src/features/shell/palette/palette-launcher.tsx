import { IconButton } from '@ptbk/ui';
import { Search } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { cx } from '../../../app/cx';
import { m } from '../../../paraglide/messages';
import type { SidebarState } from '../sidebar-preference';

// The palette's code (and its search) loads on first open, so the shell pays only for this button and the shortcut.
const LazyPaletteDialog = lazy(() => import('./palette-dialog').then((module) => ({ default: module.PaletteDialog })));

/** ⌘K on Apple keyboards, Ctrl+K elsewhere; both work everywhere. */
export function isPaletteShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>) {
    return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k';
}

export interface CommandPaletteState {
    readonly open: boolean;
    readonly openPalette: () => void;
    readonly closePalette: () => void;
    /** Whether the palette was opened at least once, so its chunk is loaded and stays mounted. */
    readonly loaded: boolean;
}

/** The palette's open state, opened by ⌘K or Ctrl+K anywhere in the app, including from inside a text field. */
export function useCommandPalette(): CommandPaletteState {
    const [open, setOpen] = useState(false);
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (!isPaletteShortcut(event)) return;
            event.preventDefault();
            setLoaded(true);
            setOpen(true);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
        };
    }, []);
    return {
        open,
        loaded,
        openPalette: () => {
            setLoaded(true);
            setOpen(true);
        },
        closePalette: () => {
            setOpen(false);
        },
    };
}

export function CommandPaletteHost({
    state,
    sidebar,
}: {
    readonly state: CommandPaletteState;
    /** The wide layout's sidebar, which the palette can collapse; `null` where there is none (the drawer). */
    readonly sidebar: SidebarState | null;
}) {
    if (!state.loaded) return null;
    return (
        <Suspense fallback={null}>
            <LazyPaletteDialog open={state.open} onClose={state.closePalette} sidebar={sidebar} />
        </Suspense>
    );
}

function shortcutHint(): string {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';
}

/** The header's way in, and the only one on touch devices. */
export function PaletteButton({ onOpen, compact }: { readonly onOpen: () => void; readonly compact: boolean }) {
    if (compact) {
        return (
            <IconButton
                variant="ghost"
                label={m.palette_open()}
                icon={<Search aria-hidden />}
                aria-keyshortcuts="Meta+K Control+K"
                aria-haspopup="dialog"
                onClick={onOpen}
            />
        );
    }
    return (
        <button
            type="button"
            // The visible "Search" stays short enough for the sidebar; the name says commands are in there too. A
            // hidden full name instead of `aria-label`, so the name is not a mismatch with the visible label.
            aria-keyshortcuts="Meta+K Control+K"
            aria-haspopup="dialog"
            onClick={onOpen}
            className={cx(
                'flex min-h-8 w-full cursor-pointer items-center gap-2.5 rounded-control bg-hover px-2.5 text-sm text-text-muted',
                'hover:bg-selected hover:text-text motion-safe:transition-colors motion-safe:duration-(--motion-state)',
            )}
        >
            <Search aria-hidden className="size-4 shrink-0" />
            <span aria-hidden="true" className="flex-1 truncate text-start">
                {m.palette_open_short()}
            </span>
            <span className="sr-only">{m.palette_open()}</span>
            <kbd aria-hidden="true" className="text-xs tabular-nums opacity-80">
                {shortcutHint()}
            </kbd>
        </button>
    );
}
