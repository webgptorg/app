/** Where the pages load their assets from; `/auth/` is engine-reserved, so a UI bundle can never shadow them. */
export const GATEWAY_ASSET_PATH = '/auth/assets/';

/** The pages and their assets on disk, for a server that reads them (Node: `fileURLToPath`). */
export const GATEWAY_PAGES_DIR: URL = new URL('../pages/', import.meta.url);

/** Templates: render them with `renderGatewayPage` and serve as `text/html; charset=utf-8`. */
export const GATEWAY_PAGES = ['setup.html', 'sign-in.html', 'step-up.html'] as const;
export type GatewayPage = (typeof GATEWAY_PAGES)[number];

/** Static files served unchanged under `GATEWAY_ASSET_PATH`, with their content types. */
export const GATEWAY_ASSETS = {
    'gateway.css': 'text/css; charset=utf-8',
    'gateway.js': 'text/javascript; charset=utf-8',
    'next-path.js': 'text/javascript; charset=utf-8',
    'simplewebauthn-browser.umd.min.js': 'text/javascript; charset=utf-8',
} as const satisfies Readonly<Record<string, string>>;
export type GatewayAsset = keyof typeof GATEWAY_ASSETS;

/**
 * SHA-256 (hex) of the vendored `@simplewebauthn/browser` 14.0.0 bundle (`dist/bundle/index.umd.min.js`). The pages
 * also pin it with Subresource Integrity; a test checks both against the installed package.
 */
export const SIMPLEWEBAUTHN_BROWSER_SHA256 = '29bb0699b45bc39a350d992a13bfc1a4d40d89531390581e1f57f1142c6e221d';
