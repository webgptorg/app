import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { IconButton } from '../icon-button/icon-button';
import { Spinner } from '../spinner/spinner';
import { useToast, useToastList } from './toast-store';
import type { ToastRecord, ToastTone } from './toast-store';

const TONE_ICONS: Readonly<Record<ToastTone, LucideIcon>> = {
    info: Info,
    success: CircleCheck,
    warning: TriangleAlert,
    danger: CircleX,
};

const TONE_ICON_CLASSES: Readonly<Record<ToastTone, string>> = {
    info: 'text-(--toast-info)',
    success: 'text-(--toast-success)',
    warning: 'text-(--toast-warning)',
    danger: 'text-(--toast-danger)',
};

const OPEN_MODAL = 'dialog[data-ptbk-modal][open]';

/**
 * The one live region for toasts. It is always in the document, even when empty, so screen readers announce what
 * arrives in it. Mount it once, next to the app, inside `UiProvider`.
 *
 * A modal `<dialog>` makes everything outside it inert, so a toast fired while one is open would sit dimmed under
 * the backdrop, unclickable and unannounced. The viewport therefore moves into the topmost open modal and back out
 * when it closes, and is a manual popover, so the top layer puts it above that dialog wherever it sits in the DOM.
 */
export function Toaster() {
    const messages = useUiMessages();
    const toasts = useToastList();
    const viewportRef = useRef<HTMLElement>(null);
    const host = useTopModalHost(viewportRef);
    return createPortal(
        <section
            ref={viewportRef}
            popover="manual"
            aria-label={messages.notifications()}
            className={cx(
                'pointer-events-none fixed inset-x-4 top-auto bottom-4 m-0 h-auto w-auto overflow-visible',
                'border-0 bg-transparent p-0 sm:start-auto sm:w-96',
            )}
        >
            <ol aria-live="polite" aria-relevant="additions text" className="flex w-full flex-col gap-2">
                {toasts.map((toast) => (
                    <ToastItem key={toast.id} toast={toast} />
                ))}
            </ol>
        </section>,
        host,
    );
}

/**
 * A container that always sits in the topmost open modal dialog, or in `<body>` when none is open, keeping the
 * viewport in it shown as a popover. Moving a popover in the DOM hides it, so every move shows it again, which also
 * raises it above the dialog that just opened.
 */
function useTopModalHost(viewportRef: RefObject<HTMLElement | null>): HTMLElement {
    const [host] = useState(() => document.createElement('div'));
    useLayoutEffect(() => {
        const modals = [...document.querySelectorAll<HTMLDialogElement>(OPEN_MODAL)];
        const place = () => {
            const target = modals.at(-1) ?? document.body;
            if (host.parentNode !== target) target.append(host);
            viewportRef.current?.togglePopover(true);
        };
        const observer = new MutationObserver((records) => {
            let changed = !host.isConnected;
            for (const record of records) {
                const dialog = record.target;
                if (record.type !== 'attributes' || !(dialog instanceof HTMLDialogElement)) continue;
                if (!dialog.hasAttribute('data-ptbk-modal')) continue;
                const index = modals.indexOf(dialog);
                if (index !== -1) modals.splice(index, 1);
                if (dialog.matches(OPEN_MODAL)) modals.push(dialog);
                changed = true;
            }
            for (let index = modals.length - 1; index >= 0; index -= 1) {
                if (modals[index]?.isConnected !== true) {
                    modals.splice(index, 1);
                    changed = true;
                }
            }
            if (changed) place();
        });
        observer.observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['open'],
        });
        place();
        return () => {
            observer.disconnect();
            host.remove();
        };
    }, [host, viewportRef]);
    return host;
}

function ToastItem({ toast }: { readonly toast: ToastRecord }) {
    const messages = useUiMessages();
    const { dismiss } = useToast();
    const [paused, setPaused] = useState({ hover: false, focus: false });
    const remaining = useRef(toast.durationMs);
    const Icon = TONE_ICONS[toast.tone];

    useEffect(() => {
        remaining.current = toast.durationMs;
    }, [toast.durationMs, toast.tone]);

    const isPaused = paused.hover || paused.focus;
    useEffect(() => {
        const left = remaining.current;
        if (left === null || toast.busy || isPaused) return;
        const startedAt = Date.now();
        const timer = setTimeout(() => {
            dismiss(toast.id);
        }, left);
        return () => {
            clearTimeout(timer);
            remaining.current = Math.max(0, left - (Date.now() - startedAt));
        };
    }, [dismiss, toast.id, toast.busy, toast.durationMs, toast.tone, isPaused]);

    return (
        <li
            onMouseEnter={() => {
                setPaused((state) => ({ ...state, hover: true }));
            }}
            onMouseLeave={() => {
                setPaused((state) => ({ ...state, hover: false }));
            }}
            onFocus={() => {
                setPaused((state) => ({ ...state, focus: true }));
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                    setPaused((state) => ({ ...state, focus: false }));
            }}
            className={cx(
                'pointer-events-auto flex items-start gap-3 rounded-(--toast-radius) border border-(--toast-border) bg-(--toast-bg) p-3 text-(--toast-text) shadow-(--toast-shadow)',
                'motion-safe:animate-[ptbk-toast-enter_var(--motion-enter)_var(--ease-enter)]',
            )}
        >
            <span className={cx('mt-0.5 flex shrink-0', TONE_ICON_CLASSES[toast.tone])}>
                {toast.busy ? (
                    <Spinner size="sm" tone="current" announce={false} />
                ) : (
                    <Icon aria-hidden="true" className="size-5" />
                )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-sm font-medium wrap-anywhere">{toast.title}</p>
                {toast.description === undefined ? null : (
                    <p className="text-sm wrap-anywhere text-(--toast-muted)">{toast.description}</p>
                )}
            </div>
            <IconButton
                label={messages.dismiss()}
                icon={<X aria-hidden="true" className="size-4" />}
                size="sm"
                className="-me-1 -mt-1"
                onClick={() => {
                    dismiss(toast.id);
                }}
            />
        </li>
    );
}
