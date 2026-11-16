import type { OrgAuditEntryId, OrgId, UserId } from '../domain/ids';
import type { LicenseSnapshot } from '../domain/licensing/license-contract';
import type { PendingLinkRecord } from '../domain/licensing/website-access';
import type { WebsiteLicensingStore } from '../domain/licensing/website-licensing-store';

export interface MemoryWebsiteLicensingStore extends WebsiteLicensingStore {
    readonly links: Map<OrgId, { subject: string; linkedByUserId: UserId; linkedAt: number }>;
    readonly snapshots: Map<string, LicenseSnapshot>;
    readonly states: Map<string, number>;
    readonly pending: Map<string, PendingLinkRecord>;
    readonly audit: { id: OrgAuditEntryId; orgId: OrgId; actorUserId: UserId; action: string; targetId: string }[];
}

/** `emailOf` stands in for the users table the D1 store joins. */
export function createMemoryWebsiteLicensingStore(
    emailOf: (userId: UserId) => string | null = () => null,
): MemoryWebsiteLicensingStore {
    const links: MemoryWebsiteLicensingStore['links'] = new Map();
    const snapshots = new Map<string, LicenseSnapshot>();
    const states = new Map<string, number>();
    const pending = new Map<string, PendingLinkRecord>();
    const audit: MemoryWebsiteLicensingStore['audit'] = [];
    return {
        links,
        snapshots,
        states,
        pending,
        audit,
        createState(state) {
            for (const [hash, expiresAt] of states) if (expiresAt <= state.createdAt) states.delete(hash);
            states.set(state.challengeHash, state.expiresAt);
            return Promise.resolve();
        },
        consumeState(challengeHash, now) {
            const expiresAt = states.get(challengeHash);
            states.delete(challengeHash);
            return Promise.resolve(expiresAt !== undefined && expiresAt > now);
        },
        createPending(record) {
            for (const [hash, row] of pending) if (row.expiresAt <= record.createdAt) pending.delete(hash);
            pending.set(record.tokenHash, record);
            return Promise.resolve();
        },
        findPending(tokenHash, now) {
            const row = pending.get(tokenHash);
            return Promise.resolve(row !== undefined && row.expiresAt > now ? row : null);
        },
        deletePending(tokenHash) {
            pending.delete(tokenHash);
            return Promise.resolve();
        },
        link(input) {
            const current = links.get(input.orgId);
            if (current !== undefined)
                return Promise.resolve(current.subject === input.subject ? 'linked' : 'conflict');
            if ([...links.values()].some((row) => row.subject === input.subject)) return Promise.resolve('conflict');
            links.set(input.orgId, { subject: input.subject, linkedByUserId: input.actorId, linkedAt: input.at });
            audit.push({
                id: input.auditId,
                orgId: input.orgId,
                actorUserId: input.actorId,
                action: 'website.link',
                targetId: input.subject,
            });
            return Promise.resolve('linked');
        },
        linkForOrg(orgId) {
            const row = links.get(orgId);
            return Promise.resolve(
                row === undefined
                    ? null
                    : { subject: row.subject, linkedAt: row.linkedAt, linkedByEmail: emailOf(row.linkedByUserId) },
            );
        },
        subjectForOrg(orgId) {
            return Promise.resolve(links.get(orgId as OrgId)?.subject ?? null);
        },
        readSnapshot(orgId) {
            return Promise.resolve(snapshots.get(orgId) ?? null);
        },
        saveSnapshot(orgId, snapshot) {
            snapshots.set(orgId, snapshot);
            return Promise.resolve();
        },
    };
}
