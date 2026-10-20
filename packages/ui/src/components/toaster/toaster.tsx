import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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

/**
 * The one live region for toasts. It is always in the document, even when empty, so screen readers announce what
 * arrives in it. Mount it once, next to the app, inside `UiProvider`.
 */
export function Toaster() {
    const messages = useUiMessages();
    const toasts = useToastList();
    return (
        <section
            aria-label={messages.notifications()}
            className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-end sm:start-auto sm:w-96"
        >
            <ol aria-live="polite" aria-relevant="additions text" className="flex w-full flex-col gap-2">
                {toasts.map((toast) => (
                    <ToastItem key={toast.id} toast={toast} />
                ))}
            </ol>
        </section>
    );
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
                <p className="text-sm font-medium">{toast.title}</p>
                {toast.description === undefined ? null : (
                    <p className="text-sm text-(--toast-muted)">{toast.description}</p>
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
