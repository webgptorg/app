import type { AuditEntry, AuditVerification } from '../audit';
import { Sha256Hex } from '../common';
import type { Timestamp } from '../common';

/** The in-memory engine's chain link: SHA-256 over every field of the entry except `hash`, in a fixed order. */
export async function hashAuditEntry(entry: Omit<AuditEntry, 'hash'>): Promise<Sha256Hex> {
    const input = JSON.stringify([
        entry.id,
        entry.seq,
        entry.at,
        entry.actor,
        entry.action,
        entry.target,
        entry.outcome,
        entry.client,
        entry.prevHash,
    ]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Sha256Hex.parse(toHex(new Uint8Array(digest)));
}

export async function sha256OfBlob(blob: Blob): Promise<Sha256Hex> {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Sha256Hex.parse(toHex(new Uint8Array(digest)));
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyAuditChain(
    entries: readonly AuditEntry[],
    checkedAt: Timestamp,
): Promise<AuditVerification> {
    let prevHash: Sha256Hex | null = null;
    let previousSeq = 0;
    for (const entry of entries) {
        const { hash, ...rest } = entry;
        const intact =
            entry.seq === previousSeq + 1 && entry.prevHash === prevHash && (await hashAuditEntry(rest)) === hash;
        if (!intact) {
            return {
                status: 'broken',
                checkedEntries: entries.length,
                lastSeq: entries.at(-1)?.seq ?? null,
                firstBrokenSeq: entry.seq,
                checkedAt,
            };
        }
        prevHash = hash;
        previousSeq = entry.seq;
    }
    return {
        status: 'intact',
        checkedEntries: entries.length,
        lastSeq: entries.at(-1)?.seq ?? null,
        firstBrokenSeq: null,
        checkedAt,
    };
}
