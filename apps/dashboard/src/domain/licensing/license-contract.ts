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
    id: z.string().uuid(),
    validFrom: z.string().datetime(),
    validUntil: z.string().datetime().nullable(),
    capabilities: licenseCapabilitiesSchema,
});
/** Responses are forward compatible; server requests remain strict at the website boundary. */
export const licenseSnapshotSchema = z.object({
    version: z.literal(1),
    subject: z.string().uuid(),
    generatedAt: z.string().datetime(),
    refreshAfterSeconds: z.number().int().min(60).max(86400),
    enforcement: z.literal('advisory'),
    manageUrl: z.literal('https://www.ptbk.io/cs/pricing/predplatne'),
    grants: z.array(licenseGrantSchema).max(1000),
});
export type LicenseGrant = z.infer<typeof licenseGrantSchema>;
export type LicenseSnapshot = z.infer<typeof licenseSnapshotSchema>;
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
