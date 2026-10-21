import type { EngineId, HostnameClaim } from '@ptbk/protocol';

import type { RelayTokenId } from '../domain/ids';
import type { EngineStore } from '../domain/registration/engine-store';
import type { EngineHostnameStore } from '../domain/registry/engine-hostname-store';
import type { RegistryReader } from '../domain/registry/registry-reader';
import type { RelayTokenStore } from '../domain/registry/relay-token-store';

/** A `relay_tokens` row as `scripts/mint-relay-key.ts` writes it. */
export interface StoredRelayToken {
    readonly id: RelayTokenId;
    readonly relayId: string;
    readonly tokenHash: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly lastUsedAt: number | null;
    readonly revokedAt: number | null;
}

export interface MemoryRelayTokenStore extends RelayTokenStore {
    readonly rows: Map<RelayTokenId, StoredRelayToken>;
}

export function createMemoryRelayTokenStore(): MemoryRelayTokenStore {
    const rows = new Map<RelayTokenId, StoredRelayToken>();
    return {
        rows,
        findLive(tokenHash, now) {
            const row = [...rows.values()].find(
                (candidate) =>
                    candidate.tokenHash === tokenHash && candidate.revokedAt === null && candidate.expiresAt > now,
            );
            return Promise.resolve(
                row === undefined ? null : { id: row.id, relayId: row.relayId, lastUsedAt: row.lastUsedAt },
            );
        },
        markUsed(id, now) {
            const row = rows.get(id);
            if (row !== undefined) {
                rows.set(id, { ...row, lastUsedAt: now });
            }
            return Promise.resolve();
        },
    };
}

/** The registry's view of the engines another store holds, as the D1 reader reads the same table. */
export function createMemoryRegistryReader(engines: Pick<EngineStore, 'findForRegistration'>): RegistryReader {
    return {
        async findEngine(engineId) {
            const engine = await engines.findForRegistration(engineId);
            return engine === null ? null : { publicKey: engine.publicKey, status: engine.status };
        },
    };
}

export interface MemoryEngineHostnameStore extends EngineHostnameStore {
    set(engineId: EngineId, claims: readonly HostnameClaim[]): void;
}

/** Stands in for D-08's `engine_hostnames` table. */
export function createMemoryEngineHostnameStore(): MemoryEngineHostnameStore {
    const claims = new Map<EngineId, readonly HostnameClaim[]>();
    return {
        set(engineId, list) {
            claims.set(engineId, list);
        },
        activeCustomHostnames: (engineId) => Promise.resolve(claims.get(engineId) ?? []),
    };
}
