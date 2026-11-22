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
export type LicenseDimension = 'specialists' | 'controllingUsers' | 'harnessInstances' | 'browserProfiles';
export interface EngineLicenseUsage {
    readonly id: string;
    /** Null is unknown, not zero. Heartbeat v1 agents/members are not commercial specialist/user counts. */
    readonly counts: Readonly<Record<LicenseDimension, number | null>>;
}
export interface WebsiteLicenseStore {
    subjectForOrg(orgId: string): Promise<string | null>;
    readSnapshot(orgId: string): Promise<LicenseSnapshot | null>;
    saveSnapshot(orgId: string, snapshot: LicenseSnapshot): Promise<void>;
}
export type LicenseRead =
    | { readonly kind: 'current'; readonly snapshot: LicenseSnapshot }
    | { readonly kind: 'stale'; readonly snapshot: LicenseSnapshot }
    | { readonly kind: 'unknown' };
