import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';

import { UiProvider } from '../i18n/ui-provider';
import type { UiMessages } from '../i18n/ui-messages';
import { TEST_MESSAGES } from './test-messages';

export interface RenderUiOptions {
    readonly locale?: string;
    readonly messages?: UiMessages;
    readonly theme?: 'light' | 'dark';
    /** Renders under a `StrictMode` root, as the apps do, so effects run, clean up and run again on mount. */
    readonly strict?: boolean;
}

export interface RenderedUi extends RenderResult {
    readonly user: UserEvent;
}

/** Renders `ui` under a `UiProvider` with test messages, in the given theme. */
export function renderUi(ui: ReactElement, options: RenderUiOptions = {}): RenderedUi {
    document.documentElement.classList.toggle('dark', options.theme === 'dark');
    const user = userEvent.setup();
    // A wrapper, not a parent element, so `rerender` keeps the provider and only updates `ui`.
    const result = render(ui, {
        reactStrictMode: options.strict === true,
        wrapper: ({ children }) => (
            <UiProvider messages={options.messages ?? TEST_MESSAGES} locale={options.locale ?? 'en'}>
                {children}
            </UiProvider>
        ),
    });
    return { ...result, user };
}
