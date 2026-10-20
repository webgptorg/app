import { createContext, use, useMemo } from 'react';
import type { ReactNode } from 'react';

import { ToastStoreProvider } from '../components/toaster/toast-store';
import { createFormatters } from './formatters';
import type { Formatters } from './formatters';
import type { UiMessages } from './ui-messages';

interface UiContextValue {
    readonly messages: UiMessages;
    readonly formatters: Formatters;
}

const UiContext = createContext<UiContextValue | null>(null);

export interface UiProviderProps {
    readonly messages: UiMessages;
    /** A BCP 47 tag, e.g. `en` or `cs`; drives the `Intl` formatters. */
    readonly locale: string;
    readonly children: ReactNode;
}

/**
 * Supplies the app's translated `UiMessages` and its locale to every `@ptbk/ui` component below it, and holds the toasts
 * that `useToast()` shows in `<Toaster />`.
 */
export function UiProvider({ messages, locale, children }: UiProviderProps) {
    const value = useMemo(() => ({ messages, formatters: createFormatters(locale) }), [messages, locale]);
    return (
        <UiContext value={value}>
            <ToastStoreProvider>{children}</ToastStoreProvider>
        </UiContext>
    );
}

function useUiContext(): UiContextValue {
    const value = use(UiContext);
    if (value === null) throw new Error('@ptbk/ui components need a <UiProvider> above them');
    return value;
}

export function useUiMessages(): UiMessages {
    return useUiContext().messages;
}

/** The locale and its memoised `Intl` formatters. */
export function useLocale(): Formatters {
    return useUiContext().formatters;
}
