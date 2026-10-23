import type { CtSourceName } from '../domain/abuse/ct-log-source';
import type { CtCertRecord, CtStore } from '../domain/abuse/ct-store';

export interface MemoryCtStore extends CtStore {
    readonly certs: Map<string, CtCertRecord>;
    readonly cursors: Map<CtSourceName, string>;
    readonly engineHostnames: Set<string>;
}

/** `ct_certs`, `ct_cursors` and the engines' default hostnames in memory; the contract suite holds it to D1's. */
export function createMemoryCtStore(): MemoryCtStore {
    const certs = new Map<string, CtCertRecord>();
    const cursors = new Map<CtSourceName, string>();
    const engineHostnames = new Set<string>();
    return {
        certs,
        cursors,
        engineHostnames,
        cursor: (source) => Promise.resolve(cursors.get(source) ?? null),
        saveCursor(source, cursor) {
            cursors.set(source, cursor);
            return Promise.resolve();
        },
        known: (keys) => Promise.resolve(new Set(keys.filter((key) => certs.has(key)))),
        insert(records) {
            for (const record of records) {
                if (!certs.has(record.issuanceSha256)) certs.set(record.issuanceSha256, record);
            }
            return Promise.resolve();
        },
        registeredHostnames: (hostnames) =>
            Promise.resolve(new Set(hostnames.filter((hostname) => engineHostnames.has(hostname)))),
        countIssuedSince: (hostname, since) =>
            Promise.resolve(
                [...certs.values()].filter((cert) => cert.notBefore >= since && cert.hostnames.includes(hostname))
                    .length,
            ),
        prune(before) {
            for (const [key, cert] of certs) {
                if (cert.firstSeenAt < before) certs.delete(key);
            }
            return Promise.resolve();
        },
    };
}
