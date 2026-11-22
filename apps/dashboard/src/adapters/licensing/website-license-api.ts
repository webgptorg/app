import { readBoundedJson } from './read-bounded-json';
import {
    licenseSnapshotSchema,
    type WebsiteLicense,
    type WebsiteLicenseApi,
} from '../../domain/licensing/license-contract';

const TIMEOUT_MS = 5_000;
const MAX_BYTES = 512 * 1024;

/**
 * The website's licence API over HTTP: today `GET /api/promptbook-billing/app/licenses?subject=`, which answers the bare
 * numeric snapshot, so status and plan name stay null. This is the one place the website's endpoint plugs in
 * (website-licensing.md, "Where the website plugs in"); the cache, the checks and the screens only see the port.
 */
export function createWebsiteLicenseHttpApi(deps: {
    /** `WEBSITE_ORIGIN`: staging may talk to a staging website. */
    readonly websiteOrigin: string;
    readonly secret: string;
    readonly fetch: typeof fetch;
}): WebsiteLicenseApi {
    const schema = licenseSnapshotSchema(deps.websiteOrigin);
    return {
        async lookup(account, signal): Promise<WebsiteLicense> {
            const response = await deps.fetch(
                `${deps.websiteOrigin}/api/promptbook-billing/app/licenses?subject=${encodeURIComponent(account.subject)}`,
                {
                    headers: { authorization: `Bearer ${deps.secret}` },
                    redirect: 'error',
                    cache: 'no-store',
                    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
                },
            );
            if (!response.ok) throw new Error('License service unavailable');
            return { snapshot: schema.parse(await readBoundedJson(response, MAX_BYTES)), status: null, label: null };
        },
    };
}
