import { Gallery } from '@ptbk/ui';

import { Page } from '../shell/page';
import { VoiceGallery } from './voice-gallery';

/**
 * `@ptbk/ui`'s gallery inside the real shell, so `test:csp` checks every component under the engine's CSP, then
 * engine-ui's own building blocks that the product does not mount yet.
 */
export function GalleryPage() {
    return (
        <Page title="@ptbk/ui">
            <div className="flex flex-col gap-10">
                <Gallery />
                <VoiceGallery />
            </div>
        </Page>
    );
}
