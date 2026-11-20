import type { LicenseRead, WebsiteLicense, WebsiteLicenseApi, WebsiteLicenseStore } from './license-contract';

/** A website clock this far ahead is wrong, and its snapshot would never refresh. */
const MAX_CLOCK_SKEW_MS = 120_000;

/**
 * Server-side polling (ADR 0021): the stored licence until `refreshAfterSeconds`, then the website; on any failure the
 * stored one as stale, or nothing. Neither the credential nor customer content belongs in the SPA.
 */
export function createLicenseReader(deps: {
    readonly api: WebsiteLicenseApi;
    readonly store: WebsiteLicenseStore;
    readonly nowMs: () => number;
}) {
    const fresh = (license: WebsiteLicense) =>
        deps.nowMs() - Date.parse(license.snapshot.generatedAt) < license.snapshot.refreshAfterSeconds * 1000;
    return {
        async read(orgId: string, signal: AbortSignal): Promise<LicenseRead> {
            const subject = await deps.store.subjectForOrg(orgId);
            if (subject === null) return { kind: 'unknown' };
            const stored = await deps.store.readLicense(orgId);
            const cached = stored !== null && stored.snapshot.subject === subject ? stored : null;
            if (cached !== null && fresh(cached)) return { kind: 'current', license: cached };
            try {
                const license = await deps.api.lookup({ subject }, signal);
                const { snapshot } = license;
                if (
                    snapshot.subject !== subject ||
                    Date.parse(snapshot.generatedAt) > deps.nowMs() + MAX_CLOCK_SKEW_MS
                ) {
                    throw new Error('License subject or time mismatch');
                }
                await deps.store.saveLicense(orgId, license);
                return { kind: 'current', license };
            } catch {
                // This status affects a notice only. Auth and security checks independently fail closed.
                return cached === null ? { kind: 'unknown' } : { kind: 'stale', license: cached };
            }
        },
    };
}
