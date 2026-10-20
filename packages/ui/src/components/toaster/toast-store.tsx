import { createContext, use, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastInput {
    readonly tone: ToastTone;
    readonly title: string;
    readonly description?: string;
    /** Milliseconds until it dismisses itself; `danger` toasts default to staying until dismissed. */
    readonly durationMs?: number;
}

export interface ToastRecord {
    readonly id: string;
    readonly tone: ToastTone;
    readonly title: string;
    readonly description: string | undefined;
    /** `null`: stays until dismissed. */
    readonly durationMs: number | null;
    /** An async outcome still pending; shows a spinner and never times out. */
    readonly busy: boolean;
}

export interface ToastPromiseMessages<T> {
    readonly loading: string;
    readonly success: string | ((value: T) => string);
    readonly error: string | ((error: unknown) => string);
}

export interface ToastApi {
    readonly show: (toast: ToastInput) => string;
    readonly dismiss: (id: string) => void;
    /** One toast for an async outcome: `loading` while pending, then success or error in place. Returns `promise`. */
    readonly promise: <T>(promise: Promise<T>, messages: ToastPromiseMessages<T>) => Promise<T>;
}

export const DEFAULT_TOAST_DURATION_MS = 5000;

const ToastApiContext = createContext<ToastApi | null>(null);
const ToastListContext = createContext<readonly ToastRecord[]>([]);

function recordOf(id: string, toast: ToastInput): ToastRecord {
    return {
        id,
        tone: toast.tone,
        title: toast.title,
        description: toast.description,
        durationMs: toast.durationMs ?? (toast.tone === 'danger' ? null : DEFAULT_TOAST_DURATION_MS),
        busy: false,
    };
}

/** Holds the toasts of one `UiProvider`; `UiProvider` mounts it, so apps never do. */
export function ToastStoreProvider({ children }: { readonly children: ReactNode }) {
    const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
    const nextId = useRef(0);

    const api = useMemo<ToastApi>(() => {
        const newId = () => {
            nextId.current += 1;
            return `toast-${String(nextId.current)}`;
        };
        const replace = (id: string, record: ToastRecord) => {
            setToasts((current) => current.map((toast) => (toast.id === id ? record : toast)));
        };
        return {
            show: (toast) => {
                const id = newId();
                setToasts((current) => [...current, recordOf(id, toast)]);
                return id;
            },
            dismiss: (id) => {
                setToasts((current) => current.filter((toast) => toast.id !== id));
            },
            promise: async (promise, messages) => {
                const id = newId();
                setToasts((current) => [
                    ...current,
                    { id, tone: 'info', title: messages.loading, description: undefined, durationMs: null, busy: true },
                ]);
                try {
                    const value = await promise;
                    const title = typeof messages.success === 'function' ? messages.success(value) : messages.success;
                    replace(id, recordOf(id, { tone: 'success', title }));
                    return value;
                } catch (error) {
                    const title = typeof messages.error === 'function' ? messages.error(error) : messages.error;
                    replace(id, recordOf(id, { tone: 'danger', title }));
                    throw error;
                }
            },
        };
    }, []);

    return (
        <ToastApiContext value={api}>
            <ToastListContext value={toasts}>{children}</ToastListContext>
        </ToastApiContext>
    );
}

/** Shows toasts through the nearest `UiProvider`'s `<Toaster />`. */
export function useToast(): ToastApi {
    const api = use(ToastApiContext);
    if (api === null) throw new Error('useToast() needs a <UiProvider> above it');
    return api;
}

export function useToastList(): readonly ToastRecord[] {
    return use(ToastListContext);
}
