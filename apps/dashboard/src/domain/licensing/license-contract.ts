import { z } from 'zod';

const capacity = z.number().int().nonnegative().max(1_000_000).nullable();
export const licenseCapabilitiesSchema = z.object({
    engineProjects: capacity,
    specialists: capacity,
    controllingUsers: capacity,
    harnessInstances: capacity,
    browserProfiles: capacity,
    remoteControl: z.boolean(),
});
export const licenseGrantSchema = z.object({
    id: z.uuid(),
    validFrom: z.iso.datetime({ offset: true }),
    validUntil: z.iso.datetime({ offset: true }).nullable(),
    capabilities: licenseCapabilitiesSchema,
});
/**
 * The manage link is shown as a link, so it must stay on the website: any locale or page there, never another origin,
 * plain http, or credentials smuggled into the URL.
 */
export function manageUrlSchema(websiteOrigin: string) {
    return z
        .url({ protocol: /^https$/ })
        .max(2048)
        .refine((value) => {
            const url = new URL(value);
            return url.origin === websiteOrigin && url.username === '' && url.password === '';
        }, 'must be on the website origin');
}
/** Responses are forward compatible; server requests remain strict at the website boundary. */
export function licenseSnapshotSchema(websiteOrigin: string) {
    return z.object({
        version: z.literal(1),
        subject: z.uuid(),
        generatedAt: z.iso.datetime({ offset: true }),
        refreshAfterSeconds: z.number().int().min(60).max(86400),
        enforcement: z.literal('advisory'),
        manageUrl: manageUrlSchema(websiteOrigin),
        grants: z.array(licenseGrantSchema).max(1000),
    });
}
export type LicenseGrant = z.infer<typeof licenseGrantSchema>;
export type LicenseSnapshot = z.infer<ReturnType<typeof licenseSnapshotSchema>>;

/** The website's own reading of an account's licences, as its lookup API words it. */
export const WEBSITE_LICENSE_STATUSES = ['active', 'trial', 'scheduled', 'expired', 'none'] as const;
export type WebsiteLicenseStatus = (typeof WEBSITE_LICENSE_STATUSES)[number];

/** Plain text the website shows as the plan's name ("Business"); rendered as text, never decides anything. */
export const licenseLabelSchema = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[^<>\p{Cc}]+$/u);

/**
 * One account's licence as the website states it: the numeric snapshot, and, where its API sends them, its status and
 * plan name. Null where the API does not say; the App then derives the status from the grants and shows no plan name.
 */
export interface WebsiteLicense {
    readonly snapshot: LicenseSnapshot;
    readonly status: WebsiteLicenseStatus | null;
    readonly label: string | null;
}

export function websiteLicenseSchema(websiteOrigin: string) {
    return z.object({
        snapshot: licenseSnapshotSchema(websiteOrigin),
        status: z.enum(WEBSITE_LICENSE_STATUSES).nullable(),
        label: licenseLabelSchema.nullable(),
    });
}

/** The linked website account, as the licence API addresses it. */
export interface WebsiteAccountRef {
    readonly subject: string;
}

/**
 * The website's licence API (ADR 0021), server to server. Rejects on any failure, an unknown account included: an
 * outage must never read as "no licence". The HTTP adapter is `adapters/licensing/website-license-api.ts`.
 */
export interface WebsiteLicenseApi {
    lookup(account: WebsiteAccountRef, signal: AbortSignal): Promise<WebsiteLicense>;
}

export type LicenseDimension = 'specialists' | 'controllingUsers' | 'harnessInstances' | 'browserProfiles';
export interface EngineLicenseUsage {
    readonly id: string;
    /** Null is unknown, not zero. Heartbeat v1 agents/members are not commercial specialist/user counts. */
    readonly counts: Readonly<Record<LicenseDimension, number | null>>;
}
export interface WebsiteLicenseStore {
    subjectForOrg(orgId: string): Promise<string | null>;
    /** The last license read for the organization, validated again on read; null when none or no longer valid. */
    readLicense(orgId: string): Promise<WebsiteLicense | null>;
    saveLicense(orgId: string, license: WebsiteLicense): Promise<void>;
}
export type LicenseRead =
    | { readonly kind: 'current'; readonly license: WebsiteLicense }
    | { readonly kind: 'stale'; readonly license: WebsiteLicense }
    | { readonly kind: 'unknown' };
