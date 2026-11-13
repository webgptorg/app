import { readBoundedJson } from './read-bounded-json';
import {
    licenseSnapshotSchema,
    type LicenseRead,
    type WebsiteLicenseStore,
} from '../../domain/licensing/license-contract';

const WEBSITE = 'https://www.ptbk.io';
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 512 * 1024;
interface ClientDeps {
    readonly secret: string;
    readonly store: WebsiteLicenseStore;
    readonly fetch: typeof fetch;
    readonly nowMs: () => number;
}
/** Server-side polling; neither the credential nor customer content belongs in the SPA. */
export function createWebsiteLicenseClient(deps: ClientDeps) {
    return {
        async read(orgId: string, signal: AbortSignal): Promise<LicenseRead> {
            const subject = await deps.store.subjectForOrg(orgId);
            if (subject === null) return { kind: 'unknown' };
            const cached = await deps.store.readSnapshot(orgId);
            if (
                cached !== null &&
                cached.subject === subject &&
                deps.nowMs() - Date.parse(cached.generatedAt) < cached.refreshAfterSeconds * 1000
            ) {
                return { kind: 'current', snapshot: cached };
            }
            try {
                const response = await deps.fetch(
                    `${WEBSITE}/api/promptbook-billing/app/licenses?subject=${encodeURIComponent(subject)}`,
                    {
                        headers: { authorization: `Bearer ${deps.secret}` },
                        redirect: 'error',
                        cache: 'no-store',
                        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
                    },
                );
                if (!response.ok) throw new Error('License service unavailable');
                const snapshot = licenseSnapshotSchema.parse(await readBoundedJson(response, MAX_BYTES));
                if (snapshot.subject !== subject || Date.parse(snapshot.generatedAt) > deps.nowMs() + 120_000) {
                    throw new Error('License subject or time mismatch');
                }
                await deps.store.saveSnapshot(orgId, snapshot);
                return { kind: 'current', snapshot };
            } catch {
                // This status affects a notice only. Auth and security checks independently fail closed.
                return cached !== null && cached.subject === subject
                    ? { kind: 'stale', snapshot: cached }
                    : { kind: 'unknown' };
            }
        },
    };
}
