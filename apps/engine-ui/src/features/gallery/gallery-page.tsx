import { Gallery } from '@ptbk/ui';

import { Page } from '../shell/page';

/** `@ptbk/ui`'s gallery inside the real shell, so `test:csp` checks every component under the engine's CSP. */
export function GalleryPage() {
    return (
        <Page title="@ptbk/ui">
            <Gallery />
        </Page>
    );
}
