/**
 * Raster types an `<img>` may show inline. The engine serves file content with its declared type and
 * `X-Content-Type-Options: nosniff`, so the browser decodes these as images and nothing else; SVG (script and external
 * references), HTML, PDF and text are never shown inline, whatever the file claims to be.
 */
const PREVIEWABLE_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Whether a file may be previewed as an image: one of the four raster types, and, on an engine that scans, scanned
 * clean. Without a scanner (`scan: null`) the type rule alone decides, as it is what keeps the preview inert.
 */
export function canPreviewImage(file: {
    readonly contentType: string;
    readonly scan: { readonly status: string } | null;
}): boolean {
    const clean = file.scan === null || file.scan.status === 'clean';
    return clean && PREVIEWABLE_IMAGE_TYPES.has(file.contentType.trim().toLowerCase());
}
