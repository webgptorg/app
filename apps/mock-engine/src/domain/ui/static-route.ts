import { ENGINE_API_PREFIX, ENGINE_RESERVED_PATHS } from '@ptbk/engine-api';
import type { UiBundleFile, UiBundleManifest } from '@ptbk/protocol';
import { UI_BUNDLE_ENTRY } from '@ptbk/protocol';

export type StaticCache = 'immutable' | 'no-cache';

export type StaticResolution =
    | {
          readonly kind: 'asset';
          readonly file: UiBundleFile;
          readonly contentType: string;
          readonly cache: StaticCache;
      }
    | { readonly kind: 'spa-fallback' }
    | { readonly kind: 'not-found' };

/** By extension, fixed: nothing in the bundle or the request chooses a type (the responses also carry `nosniff`). */
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json',
    map: 'application/json',
    webmanifest: 'application/manifest+json',
    txt: 'text/plain; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf',
    wasm: 'application/wasm',
});
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * Never answered with `index.html`: the engine's own paths (`ENGINE_RESERVED_PATHS`: API, gateway, setup,
 * `.well-known`), the bundle's asset directory and the spike endpoints. A miss there is a 404, so a typo in an API or
 * asset URL never turns into a 200 HTML page.
 */
const NO_FALLBACK_PREFIXES: readonly string[] = [
    ...ENGINE_RESERVED_PATHS,
    `${ENGINE_API_PREFIX}/`,
    '/assets/',
    '/__spike/',
    '/__mock/',
];

/** Vite's content-hashed output (`assets/index-BxD3f9_a.js`): its bytes never change under that name. */
const HASHED_ASSET = /^assets\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** Whether a path belongs to the engine or to assets, so it never gets the app's entry page. */
export function isReserved(path: string): boolean {
    return NO_FALLBACK_PREFIXES.some((prefix) => {
        const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
        return path === bare || path.startsWith(`${bare}/`);
    });
}

function contentTypeOf(path: string): string {
    const dot = path.lastIndexOf('.');
    const extension = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    return CONTENT_TYPES[extension] ?? FALLBACK_CONTENT_TYPE;
}

function asset(file: UiBundleFile): Extract<StaticResolution, { readonly kind: 'asset' }> {
    const cache = file.path !== UI_BUNDLE_ENTRY && HASHED_ASSET.test(file.path) ? 'immutable' : 'no-cache';
    return { kind: 'asset', file, contentType: contentTypeOf(file.path), cache };
}

/**
 * Which file of the verified manifest a request gets. `path` is the raw request path: it is never percent-decoded,
 * and manifest paths are strict ASCII without `%`, so an encoded path simply matches nothing. Only files the manifest
 * lists are ever served; `GET` or `HEAD` of a document (`Accept` with `text/html`) outside the reserved paths gets the
 * entry, so client-side routes like `/agents/123` load the app.
 */
export function resolveStatic(
    path: string,
    method: string,
    accept: string | undefined,
    manifest: UiBundleManifest,
): StaticResolution {
    if (method !== 'GET' && method !== 'HEAD') return { kind: 'not-found' };
    const wanted = path === '/' ? UI_BUNDLE_ENTRY : path.slice(1);
    const file = path.startsWith('/') ? manifest.files.find((candidate) => candidate.path === wanted) : undefined;
    if (file !== undefined) return asset(file);
    if (isReserved(path) || accept?.toLowerCase().includes('text/html') !== true) return { kind: 'not-found' };
    return { kind: 'spa-fallback' };
}

/** The entry file of a manifest (C-06 guarantees it is listed). */
export function entryOf(manifest: UiBundleManifest): Exclude<StaticResolution, { readonly kind: 'spa-fallback' }> {
    const file = manifest.files.find((candidate) => candidate.path === manifest.entry);
    return file === undefined ? { kind: 'not-found' } : asset(file);
}
