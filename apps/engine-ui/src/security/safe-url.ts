import { ENGINE_RESERVED_PATHS } from '@ptbk/engine-api';

/**
 * A path on `origin` that is safe to send as the gateway's `next` parameter, or `null`. Parsing against the origin
 * catches protocol-relative and backslash forms (`//evil.example`, `/\evil.example`); engine-owned paths are refused
 * so a sign-in can never bounce back into the gateway.
 */
export function safeNextPath(value: string, origin: string): string | null {
    if (!value.startsWith('/')) return null;
    let url: URL;
    try {
        url = new URL(value, origin);
    } catch {
        return null;
    }
    if (url.origin !== origin) return null;
    if (ENGINE_RESERVED_PATHS.some((reserved) => url.pathname.startsWith(reserved))) return null;
    return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * An image source the engine CSP allows (`img-src 'self' data:`), or `null`: a same-origin path or a `data:` image.
 * Anything else would be blocked anyway, and must never reach the DOM as an attempt to load from elsewhere.
 */
export function safeImageSource(value: string): string | null {
    if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
    return value;
}

/**
 * The one decision for links and images in untrusted content (agent replies): the URL to link to, or `null` to show
 * it as text. Only absolute `http:` and `https:` URLs to another origin qualify. Everything else is refused: script and
 * data-carrying schemes (`javascript:`, `data:`, `vbscript:`, `blob:`, `file:`), relative and same-origin URLs (a link
 * into this UI or its API, which the session cookie would authorise), and URLs with credentials, which mostly serve to
 * disguise the real host (`https://trusted.example@evil.example`).
 */
export function safeLinkUrl(href: string, origin: string): string | null {
    // The URL parser drops tabs and newlines inside a scheme (`java\tscript:`), so the scheme check runs on its result.
    if (!/^\s*https?:\/\//i.test(href.replace(/[\t\n\r]/g, ''))) return null;
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    if (url.username !== '' || url.password !== '') return null;
    if (url.origin === origin) return null;
    return url.href;
}
