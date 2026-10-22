import type { EngineId } from '@ptbk/protocol';

import type { OrgAuditEntryId, OrgId, UserId } from '../domain/ids';
import { OWNER_REVOKED, type EngineRecord, type EngineStore } from '../domain/registration/engine-store';
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
    readonly state: MemoryRegistrationState;
}

function redeemable(code: StoredLinkCode | undefined, orgId: OrgId | null, now: number): code is StoredLinkCode {
    return (
        code !== undefined && code.usedAt === null && now < code.expiresAt && (orgId === null || code.orgId === orgId)
    );
}

/**
 * {@link LinkCodeStore} and {@link EngineStore} in memory, sharing one state as the D1 tables share one database; the
 * contract suite holds them to the D1 adapter's behaviour. `orgExists` stands in for the foreign key to `organizations`.
 */
export function createMemoryRegistrationStores(deps: {
    readonly orgExists: (orgId: OrgId) => boolean;
}): MemoryRegistrationStores {
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
            state.linkCodes.set(record.codeHash, { ...record, usedAt: null, engineId: null });
            return Promise.resolve();
        },
        countActive: (orgId, now) => Promise.resolve(codes().filter((code) => redeemable(code, orgId, now)).length),
        countIssuedSince: (orgId, since) =>
            Promise.resolve(codes().filter((code) => code.orgId === orgId && code.createdAt > since).length),
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
        findForRegistration: (engineId) => Promise.resolve(state.engines.get(engineId) ?? null),
    };

    return { linkCodes, engines, state };
}
