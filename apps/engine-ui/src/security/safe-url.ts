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
