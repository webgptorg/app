import { UiProvider } from '@ptbk/ui';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';

import { BrowserProvider } from '../app/browser-context';
import { createUiMessages } from '../app/ui-messages';
import { createFakeLocation, TEST_ORIGIN } from './fake-location';
import { createFakeMatchMedia } from './fake-match-media';
import { createMemoryStorage } from './memory-storage';

export { TEST_ORIGIN };

function UiProviders({ children }: { readonly children: ReactNode }) {
    return (
        <UiProvider messages={createUiMessages()} locale="en">
            <BrowserProvider
                browser={{
                    storage: createMemoryStorage(),
                    matchMedia: createFakeMatchMedia().matchMedia,
                    location: createFakeLocation('/'),
                    fetch: vi.fn<typeof fetch>(),
                }}
            >
                {children}
            </BrowserProvider>
        </UiProvider>
    );
}

/** A component on its own, with the providers every engine-ui component may read (`@ptbk/ui`, browser APIs). */
export function renderUi(ui: ReactNode): RenderResult {
    return render(ui, { wrapper: UiProviders });
}
