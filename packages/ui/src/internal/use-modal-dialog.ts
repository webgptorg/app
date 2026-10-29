import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import { focusableIn, wrapTabFocus } from './focus';

export interface ModalDialogOptions {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly initialFocusRef?: RefObject<HTMLElement | null> | undefined;
}

/**
 * Drives a native `<dialog>` as a modal from React state, for `Dialog` and `Drawer`: `showModal()` on open, focus
 * moved in and returned to the opener on close, Tab wrapped inside, Esc and a backdrop click reported through
 * `onClose` so the owner's state stays the source of truth.
 */
export function useModalDialog({
    open,
    onClose,
    initialFocusRef,
}: ModalDialogOptions): RefObject<HTMLDialogElement | null> {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const openerRef = useRef<HTMLElement | null>(null);
    /** Whether this hook holds the dialog open, so a close it did not ask for (e.g. a form's `method="dialog"`) is reported. */
    const shownRef = useRef(false);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog === null || !open) return;
        const active = document.activeElement;
        openerRef.current = active instanceof HTMLElement ? active : null;
        if (!dialog.open) dialog.showModal();
        shownRef.current = true;
        const target = initialFocusRef?.current ?? focusableIn(dialog)[0] ?? dialog;
        target.focus();
        return () => {
            shownRef.current = false;
            if (dialog.open) dialog.close();
            const opener = openerRef.current;
            openerRef.current = null;
            if (opener?.isConnected === true) opener.focus();
        };
    }, [open, initialFocusRef]);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (dialog === null) return;
        const onCancel = (event: Event) => {
            event.preventDefault();
            onCloseRef.current();
        };
        // A click whose target is the dialog element itself landed on the backdrop: the content fills the box.
        const onClick = (event: MouseEvent) => {
            if (event.target === dialog) onCloseRef.current();
        };
        // The close event is queued, so when the show effect re-runs (StrictMode's mount, a new `initialFocusRef`)
        // the event from its close() arrives after showModal(): stale, as the dialog is open again.
        const onNativeClose = () => {
            if (!shownRef.current || dialog.open) return;
            shownRef.current = false;
            onCloseRef.current();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Tab' && wrapTabFocus(dialog, event.shiftKey)) event.preventDefault();
        };
        dialog.addEventListener('cancel', onCancel);
        dialog.addEventListener('click', onClick);
        dialog.addEventListener('keydown', onKeyDown);
        dialog.addEventListener('close', onNativeClose);
        return () => {
            dialog.removeEventListener('close', onNativeClose);
            dialog.removeEventListener('cancel', onCancel);
            dialog.removeEventListener('click', onClick);
            dialog.removeEventListener('keydown', onKeyDown);
        };
    }, []);

    return dialogRef;
}
