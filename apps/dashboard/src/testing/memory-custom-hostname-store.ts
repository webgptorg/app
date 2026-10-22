import { orgIdSchema, userIdSchema } from '../domain/ids';
import type { AdminAuditLog } from '../domain/auth/auth-store';
import type { CustomHostnameRecord, CustomHostnameStore } from '../domain/custom-hostnames/custom-hostname-store';
import type { EngineStore } from '../domain/registration/engine-store';
import type { EngineHostnameStore } from '../domain/registry/engine-hostname-store';
import type { MemoryEngineHostnameStore } from './memory-registry-stores';

export interface MemoryCustomHostnameStore extends CustomHostnameStore, EngineHostnameStore, MemoryEngineHostnameStore {
    readonly rows: Map<string, CustomHostnameRecord>;
}

/** Rows seeded with `set` exist for registry reads only; no admin flow reads their organization. */
const SEEDED_ORG = orgIdSchema.parse('seededseededseededseededse');
const SEEDED_BY = userIdSchema.parse('seededseededseededseededse');

/** Stands in for `engine_hostnames`; audit entries go to the auth store's log, as D1 writes them to the same table. */
export function createMemoryCustomHostnameStore(deps: {
    readonly engines: Pick<EngineStore, 'findForRegistration'>;
    readonly auditLog: AdminAuditLog;
}): MemoryCustomHostnameStore {
    const rows = new Map<string, CustomHostnameRecord>();
    const forEngine = (engineId: string) =>
        [...rows.values()]
            .filter((row) => row.engineId === engineId)
            .sort((a, b) => a.createdAt - b.createdAt || a.hostname.localeCompare(b.hostname));
    const owned = (engineId: string, hostname: string) => {
        const row = rows.get(hostname);
        return row?.engineId === engineId ? row : null;
    };
    return {
        rows,
        set(engineId, claims) {
            for (const row of forEngine(engineId)) {
                rows.delete(row.hostname);
            }
            for (const claim of claims) {
                rows.set(claim.hostname, {
                    hostname: claim.hostname,
                    engineId,
                    orgId: SEEDED_ORG,
                    claimSig: claim.sig,
                    status: 'active',
                    dnsCheckedAt: 0,
                    createdAt: 0,
                    createdByUserId: SEEDED_BY,
                });
            }
        },
        activeCustomHostnames: (engineId) =>
            Promise.resolve(
                forEngine(engineId)
                    .filter((row) => row.status === 'active')
                    .map((row) => ({ hostname: row.hostname, sig: row.claimSig })),
            ),
        async findEngine(engineId) {
            const engine = await deps.engines.findForRegistration(engineId);
            return engine === null ? null : { orgId: engine.orgId, publicKey: engine.publicKey };
        },
        listForEngine: (engineId) => Promise.resolve(forEngine(engineId)),
        find: (engineId, hostname) => Promise.resolve(owned(engineId, hostname)),
        isAssigned: (hostname) => Promise.resolve(rows.has(hostname)),
        async insert(record, audit) {
            if (rows.has(record.hostname)) {
                return 'taken';
            }
            rows.set(record.hostname, record);
            await deps.auditLog.append(audit);
            return 'inserted';
        },
        async recordDnsCheck(engineId, hostname, check, audit) {
            const row = owned(engineId, hostname);
            if (row === null) {
                return 'not-found';
            }
            rows.set(hostname, { ...row, status: check.status, dnsCheckedAt: check.checkedAt });
            if (audit !== null) {
                await deps.auditLog.append(audit);
            }
            return 'updated';
        },
        async remove(engineId, hostname, audit) {
            if (owned(engineId, hostname) === null) {
                return 'not-found';
            }
            rows.delete(hostname);
            await deps.auditLog.append(audit);
            return 'removed';
        },
    };
}
