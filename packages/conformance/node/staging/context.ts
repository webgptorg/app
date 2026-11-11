import { boundedGet } from './bounded-get';
import type { Fetched } from './bounded-get';
import type { StagingOptions, StagingPorts } from './types';

/** Pages, API answers and assets are small; the cap only stops a misbehaving server from filling memory. */
export const PAGE_MAX_BYTES = 4 * 1024 * 1024;
export const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

export const COOKIE_FIX =
    'set PTBK_CONFORMANCE_OWNER_COOKIE=<name>=<value> to an owner session: sign in on the engine in a browser and copy its session cookie from devtools (Application > Cookies; the mock engine names it __Host-ptbk_session)';
export const COOKIE_REFUSED_FIX =
    'the engine refused PTBK_CONFORMANCE_OWNER_COOKIE: it expired, was signed out or belongs to another engine; sign in again and copy a fresh one';

/**
 * How a browser on the engine's origin asks: a top-level navigation for documents, a same-origin fetch for the API
 * (`Origin` and `Sec-Fetch-Site`, which gateways require), a subresource load for assets.
 */
export type EngineRequestKind = 'document' | 'api' | 'asset';

const HEADERS: Readonly<Record<EngineRequestKind, Readonly<Record<string, string>>>> = {
    document: {
        Accept: 'text/html',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
    },
    api: {
        Accept: 'application/json',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
    },
    asset: { Accept: '*/*', 'Sec-Fetch-Site': 'same-origin' },
};

export interface StagingContext {
    readonly options: StagingOptions;
    readonly ports: StagingPorts;
    /** Whether an owner cookie was given. */
    readonly hasSession: boolean;
    engineGet(path: string, kind: EngineRequestKind, session: boolean): Promise<Fetched>;
    storeGet(path: string, maxBytes: number): Promise<Fetched>;
}

export function createStagingContext(options: StagingOptions, ports: StagingPorts): StagingContext {
    const common = { timeoutMs: options.timeoutMs, signal: options.signal };
    return {
        options,
        ports,
        hasSession: options.ownerCookie !== null,
        engineGet(path, kind, session) {
            const headers: Record<string, string> = { ...HEADERS[kind] };
            if (kind === 'api') headers['Origin'] = options.engine.origin;
            if (session && options.ownerCookie !== null) headers['Cookie'] = options.ownerCookie;
            return boundedGet(ports.fetch, new URL(path, options.engine), {
                ...common,
                headers,
                maxBytes: PAGE_MAX_BYTES,
            });
        },
        storeGet(path, maxBytes) {
            return boundedGet(ports.fetch, new URL(path, options.releaseUrl), { ...common, headers: {}, maxBytes });
        },
    };
}
