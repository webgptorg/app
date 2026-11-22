import type {
    LicenseGrant,
    LicenseSnapshot,
    WebsiteLicense,
    WebsiteLicenseApi,
    WebsiteLicenseStatus,
} from '../domain/licensing/license-contract';

export const FAKE_LICENSE_ORIGIN = 'https://www.ptbk.io';
const MANAGE_URL = `${FAKE_LICENSE_ORIGIN}/cs/pricing/predplatne`;

export const BUSINESS_CAPABILITIES: LicenseGrant['capabilities'] = {
    engineProjects: 1,
    specialists: 10,
    controllingUsers: 5,
    harnessInstances: null,
    browserProfiles: 5,
    remoteControl: true,
};

export interface FakeLicenseAccount {
    readonly grants: readonly LicenseGrant[];
    readonly status?: WebsiteLicenseStatus;
    readonly label?: string;
}

/**
 * The licence API as a port, for unit tests: no HTTP, a fixed clock and the answers of the website's lookup fixtures
 * (`docs/fixtures/app-license-email-lookup.json` in `webgptorg/ptbk-landing-page-aldaron`). An unknown subject or an
 * `outage` rejects, as the HTTP adapter does on 404 or 503.
 */
export function createFakeWebsiteLicenseApi(options: { readonly nowMs: () => number }) {
    const accounts = new Map<string, FakeLicenseAccount>();
    const lookups: string[] = [];
    const fake = {
        outage: false,
        lookups,
        set(subject: string, account: FakeLicenseAccount) {
            accounts.set(subject, account);
        },
        api: {
            lookup(account, signal): Promise<WebsiteLicense> {
                lookups.push(account.subject);
                const found = accounts.get(account.subject);
                if (fake.outage || found === undefined || signal.aborted) {
                    return Promise.reject(new Error('License service unavailable'));
                }
                const snapshot: LicenseSnapshot = {
                    version: 1,
                    subject: account.subject,
                    generatedAt: new Date(options.nowMs()).toISOString(),
                    refreshAfterSeconds: 900,
                    enforcement: 'advisory',
                    manageUrl: MANAGE_URL,
                    grants: [...found.grants],
                };
                return Promise.resolve({ snapshot, status: found.status ?? null, label: found.label ?? null });
            },
        } satisfies WebsiteLicenseApi,
    };
    return fake;
}
