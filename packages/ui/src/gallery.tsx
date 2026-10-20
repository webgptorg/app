import { buttonGallery } from './components/button/button.gallery';
import { spinnerGallery } from './components/spinner/spinner.gallery';
import { visuallyHiddenGallery } from './components/visually-hidden/visually-hidden.gallery';
import type { GalleryEntry } from './gallery-entry';

/** Every component module's gallery entry, in alphabetical order. */
export const GALLERY_ENTRIES: readonly GalleryEntry[] = [buttonGallery, spinnerGallery, visuallyHiddenGallery];

/**
 * Every component in every state. A developer and test tool: engine-ui mounts it only in its `test:csp` build, which
 * visits it in both themes, both languages and with reduced motion under the engine's CSP.
 */
export function Gallery() {
    return (
        <div className="flex flex-col gap-10">
            {GALLERY_ENTRIES.map((entry) => (
                <section key={entry.id} aria-labelledby={`gallery-${entry.id}`} className="flex flex-col gap-4">
                    <h2 id={`gallery-${entry.id}`} className="text-xl font-semibold">
                        {entry.title}
                    </h2>
                    {entry.render()}
                </section>
            ))}
        </div>
    );
}
