/**
 * Raster types an `<img>` may show inline. The engine serves file content with its declared type and
 * `X-Content-Type-Options: nosniff`, so the browser decodes these as images and nothing else; SVG (script and external
 * references), HTML, PDF and text are never shown inline, whatever the file claims to be.
 */
const PREVIEWABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Whether a file may be previewed as an image: one of the four raster types, and scanned clean. */
export function canPreviewImage(file: {
    readonly contentType: string;
    readonly scan: { readonly status: string };
}): boolean {
    return file.scan.status === 'clean' && PREVIEWABLE_IMAGE_TYPES.has(file.contentType.trim().toLowerCase());
}
