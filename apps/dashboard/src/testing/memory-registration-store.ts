import type { EngineId } from '@ptbk/protocol';

import type { AdminAuditLog } from '../domain/auth/auth-store';
import type { AdminAuditEntry } from '../domain/auth/records';
import type { PlatformEngineStore } from '../domain/engines/platform-engine-store';
import type { OrgAuditEntryId, OrgId, UserId } from '../domain/ids';
import {
    OWNER_REVOKED,
    PLATFORM_SUSPENDED,
    type EngineRecord,
    type EngineStore,
} from '../domain/registration/engine-store';
import type { LinkCodeRecord, LinkCodeStore } from '../domain/registration/link-code-store';

export interface StoredLinkCode extends LinkCodeRecord {
    readonly usedAt: number | null;
    readonly engineId: EngineId | null;
}

/** An `org_audit_log` row. */
export interface StoredOrgAuditEntry {
    readonly id: OrgAuditEntryId;
    readonly orgId: OrgId;
    readonly actorUserId: UserId;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly createdAt: number;
}

export interface MemoryRegistrationState {
    readonly linkCodes: Map<string, StoredLinkCode>;
    readonly engines: Map<EngineId, EngineRecord>;
    readonly orgAudit: StoredOrgAuditEntry[];
}

export interface MemoryRegistrationStores {
    readonly linkCodes: LinkCodeStore;
    readonly engines: EngineStore;
    readonly platformEngines: PlatformEngineStore;
    readonly state: MemoryRegistrationState;
}

function redeemable(code: StoredLinkCode | undefined, orgId: OrgId | null, now: number): code is StoredLinkCode {
    return (
        code !== undefined && code.usedAt === null && now < code.expiresAt && (orgId === null || code.orgId === orgId)
    );
}

/**
 * {@link LinkCodeStore}, {@link EngineStore} and {@link PlatformEngineStore} in memory, sharing one state as the D1
 * tables share one database; the contract suite holds them to the D1 adapter's behaviour. `orgExists` stands in for the
 * foreign key to `organizations`; admin audit entries go to `adminAudit` (the auth store's log, as D1 writes them to
 * the same table) or are kept in `adminAuditEntries`.
 */
export function createMemoryRegistrationStores(deps: {
    readonly orgExists: (orgId: OrgId) => boolean;
    readonly adminAudit?: AdminAuditLog;
}): MemoryRegistrationStores & { readonly adminAuditEntries: readonly AdminAuditEntry[] } {
    const state: MemoryRegistrationState = { linkCodes: new Map(), engines: new Map(), orgAudit: [] };
    const codes = () => [...state.linkCodes.values()];

    const linkCodes: LinkCodeStore = {
        insert(record) {
            if (!deps.orgExists(record.orgId)) {
                return Promise.reject(new Error('FOREIGN KEY constraint failed'));
            }
            if (state.linkCodes.has(record.codeHash)) {
                return Promise.reject(new Error('UNIQUE constraint failed: link_codes.code_hash'));
            }
            if (codes().some((code) => code.id === record.id)) {
                return Promise.reject(new Error('UNIQUE constraint failed: link_codes.id'));
            }
            state.linkCodes.set(record.codeHash, { ...record, usedAt: null, engineId: null });
            return Promise.resolve();
        },
        countActive: (orgId, now) => Promise.resolve(codes().filter((code) => redeemable(code, orgId, now)).length),
        countIssuedSince: (orgId, since) =>
            Promise.resolve(codes().filter((code) => code.orgId === orgId && code.createdAt > since).length),
        findState(orgId, id, now) {
            const code = codes().find((candidate) => candidate.id === id && candidate.orgId === orgId);
            if (code === undefined) {
                return Promise.resolve(null);
            }
            if (code.engineId !== null) {
                return Promise.resolve({ kind: 'linked', engineId: code.engineId });
            }
            return Promise.resolve(
                now < code.expiresAt ? { kind: 'pending', expiresAt: code.expiresAt } : { kind: 'expired' },
            );
        },
        findRedeemable(codeHash, now) {
            const code = state.linkCodes.get(codeHash);
            return Promise.resolve(redeemable(code, null, now) ? code.orgId : null);
        },
        redeemForNewEngine(codeHash, engine) {
            const code = state.linkCodes.get(codeHash);
            if (!redeemable(code, engine.orgId, engine.createdAt) || state.engines.has(engine.engineId)) {
                return Promise.resolve('conflict');
            }
            state.linkCodes.set(codeHash, { ...code, usedAt: engine.createdAt, engineId: engine.engineId });
            state.engines.set(engine.engineId, engine);
            return Promise.resolve('redeemed');
        },
        redeemForExistingEngine(codeHash, refresh) {
            const code = state.linkCodes.get(codeHash);
            const engine = state.engines.get(refresh.engineId);
            if (
                !redeemable(code, refresh.orgId, refresh.now) ||
                engine?.orgId !== refresh.orgId ||
                engine.status !== 'active'
            ) {
                return Promise.resolve('conflict');
            }
            state.linkCodes.set(codeHash, { ...code, usedAt: refresh.now, engineId: refresh.engineId });
            state.engines.set(refresh.engineId, {
                ...engine,
                mode: refresh.mode,
                engineVersion: refresh.engineVersion,
                updatedAt: refresh.now,
            });
            return Promise.resolve('redeemed');
        },
    };

    const engines: EngineStore = {
        countActive: (orgId) =>
            Promise.resolve(
                [...state.engines.values()].filter((engine) => engine.orgId === orgId && engine.status === 'active')
                    .length,
            ),
        listForOrg: (orgId) =>
            Promise.resolve(
                [...state.engines.values()]
                    .filter((engine) => engine.orgId === orgId)
                    .sort((a, b) => a.createdAt - b.createdAt || (a.engineId < b.engineId ? -1 : 1)),
            ),
        findInOrg(orgId, engineId) {
            const engine = state.engines.get(engineId);
            return Promise.resolve(engine?.orgId === orgId ? engine : null);
        },
        revoke(orgId, engineId, audit) {
            const engine = state.engines.get(engineId);
            if (engine?.orgId !== orgId) {
                return Promise.resolve('not-found');
            }
            if (engine.status === 'suspended' && engine.statusReason === OWNER_REVOKED) {
                return Promise.resolve('already-revoked');
            }
            state.engines.set(engineId, {
                ...engine,
                status: 'suspended',
                statusReason: OWNER_REVOKED,
                updatedAt: audit.at,
            });
            state.orgAudit.push({
                id: audit.id,
                orgId,
                actorUserId: audit.actorUserId,
                action: 'engine.revoke',
                targetType: 'engine',
                targetId: engineId,
                createdAt: audit.at,
            });
            return Promise.resolve('revoked');
        },
        rename(orgId, engineId, label, audit) {
            const engine = state.engines.get(engineId);
            if (engine?.orgId !== orgId) {
                return Promise.resolve('not-found');
            }
            if (engine.label === label) {
                return Promise.resolve('unchanged');
            }
            state.engines.set(engineId, { ...engine, label, updatedAt: audit.at });
            state.orgAudit.push({
                id: audit.id,
                orgId,
                actorUserId: audit.actorUserId,
                action: 'engine.rename',
                targetType: 'engine',
                targetId: engineId,
                createdAt: audit.at,
            });
            return Promise.resolve('renamed');
        },
        findForRegistration: (engineId) => Promise.resolve(state.engines.get(engineId) ?? null),
    };

    const adminAuditEntries: AdminAuditEntry[] = [];
    const appendAudit = (entry: AdminAuditEntry): Promise<void> => {
        if (deps.adminAudit !== undefined) {
            return deps.adminAudit.append(entry);
        }
        adminAuditEntries.push(entry);
        return Promise.resolve();
    };

    const platformEngines: PlatformEngineStore = {
        find: (engineId) => Promise.resolve(state.engines.get(engineId) ?? null),
        async suspend(engineId, audit) {
            const engine = state.engines.get(engineId);
            if (engine === undefined) {
                return 'not-found';
            }
            if (engine.status !== 'active') {
                return 'already-suspended';
            }
            // Changed before the audit write yields, as D1's transaction would, so a concurrent call sees it.
            state.engines.set(engineId, {
                ...engine,
                status: 'suspended',
                statusReason: PLATFORM_SUSPENDED,
                updatedAt: audit.createdAt,
            });
            await appendAudit(audit);
            return 'suspended';
        },
        async unsuspend(engineId, audit) {
            const engine = state.engines.get(engineId);
            if (engine === undefined) {
                return 'not-found';
            }
            if (engine.status === 'suspended' && engine.statusReason === OWNER_REVOKED) {
                return 'owner-revoked';
            }
            if (engine.status !== 'suspended' || engine.statusReason !== PLATFORM_SUSPENDED) {
                return 'not-suspended';
            }
            state.engines.set(engineId, {
                ...engine,
                status: 'active',
                statusReason: null,
                updatedAt: audit.createdAt,
            });
            await appendAudit(audit);
            return 'unsuspended';
        },
    };

    return { linkCodes, engines, platformEngines, state, adminAuditEntries };
}
