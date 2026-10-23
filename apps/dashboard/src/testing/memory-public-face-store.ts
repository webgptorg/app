import type { PublicFaceRecord, PublicFaceStore } from '../domain/abuse/public-face-store';
import type { EngineRecord } from '../domain/registration/engine-store';

export interface MemoryPublicFaceStore extends PublicFaceStore {
    readonly checks: PublicFaceRecord[];
}

/** `public_face_checks` in memory, over the engines `engines` lists; the contract suite holds it to D1's. */
export function createMemoryPublicFaceStore(deps: {
    readonly engines: () => Iterable<EngineRecord>;
}): MemoryPublicFaceStore {
    const checks: PublicFaceRecord[] = [];
    const lastCheck = (engineId: string) =>
        Math.max(-Infinity, ...checks.filter((check) => check.engineId === engineId).map((check) => check.checkedAt));
    const active = () => [...deps.engines()].filter((engine) => engine.status === 'active');
    return {
        checks,
        due: (limit) =>
            Promise.resolve(
                active()
                    .sort((a, b) => lastCheck(a.engineId) - lastCheck(b.engineId) || (a.engineId < b.engineId ? -1 : 1))
                    .slice(0, limit)
                    .map((engine) => ({ engineId: engine.engineId, hostname: engine.hostname })),
            ),
        record(records) {
            for (const record of records) {
                const exists = checks.some(
                    (check) => check.engineId === record.engineId && check.checkedAt === record.checkedAt,
                );
                if (!exists) checks.push(record);
            }
            return Promise.resolve();
        },
        countUncheckedSince: (since) =>
            Promise.resolve(active().filter((engine) => lastCheck(engine.engineId) < since).length),
        prune(before) {
            const kept = checks.filter((check) => check.checkedAt >= before);
            checks.splice(0, checks.length, ...kept);
            return Promise.resolve();
        },
    };
}
