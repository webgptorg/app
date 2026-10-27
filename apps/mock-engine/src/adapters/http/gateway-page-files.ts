import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import type { GatewayAsset, GatewayPage } from '@ptbk/gateway-pages';
import { GATEWAY_ASSETS, GATEWAY_PAGES, GATEWAY_PAGES_DIR } from '@ptbk/gateway-pages';

/** The reference pages and their assets, read once at startup and served from memory. */
export interface GatewayPageFiles {
    readonly pages: Readonly<Record<GatewayPage, string>>;
    readonly assets: ReadonlyMap<GatewayAsset, { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }>;
}

/**
 * Where the pages are: next to the bundle (`dist/gateway-pages/`, copied there by the build, so the engine image
 * needs nothing else), or in the workspace package when running from source.
 */
export function gatewayPagesDir(bundleUrl: string | URL): URL {
    const bundled = new URL('./gateway-pages/', bundleUrl);
    return existsSync(bundled) ? bundled : GATEWAY_PAGES_DIR;
}

export async function loadGatewayPageFiles(dir: URL = GATEWAY_PAGES_DIR): Promise<GatewayPageFiles> {
    const pages = Object.fromEntries(
        await Promise.all(
            GATEWAY_PAGES.map(async (name: GatewayPage) => [name, await readFile(new URL(name, dir), 'utf8')] as const),
        ),
    ) as Record<GatewayPage, string>;
    const assets = new Map<GatewayAsset, { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }>();
    for (const [name, type] of Object.entries(GATEWAY_ASSETS) as [GatewayAsset, string][]) {
        assets.set(name, { bytes: new Uint8Array(await readFile(new URL(name, dir))), type });
    }
    return { pages, assets };
}
