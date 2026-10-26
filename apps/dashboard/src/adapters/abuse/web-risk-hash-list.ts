/**
 * A Web Risk threat list held locally (Update API): hash prefixes grouped by length, each group sorted and packed into
 * one byte array, so a list of a million 4-byte prefixes costs 4 MiB rather than a million objects.
 */
export interface HashPrefixList {
    /** Prefix length in bytes (4–32) to that length's prefixes, ascending, concatenated. */
    readonly groups: ReadonlyMap<number, Uint8Array>;
}

/** One `computeDiff` answer, decoded. Removals index the list as it was, sorted, before the additions. */
export interface HashListUpdate {
    readonly kind: 'diff' | 'reset';
    readonly additions: readonly { readonly prefixSize: number; readonly hashes: Uint8Array }[];
    readonly removals: readonly number[];
    /** SHA-256 of every prefix of the updated list, sorted, concatenated. */
    readonly checksum: Uint8Array;
}

export const MIN_PREFIX_BYTES = 4;
export const MAX_PREFIX_BYTES = 32;

export const EMPTY_HASH_LIST: HashPrefixList = { groups: new Map() };

/** Lexicographic, with a prefix before every longer value that starts with it, as Web Risk sorts. */
function compare(a: Uint8Array, aOffset: number, aSize: number, b: Uint8Array, bOffset: number, bSize: number): number {
    const shared = Math.min(aSize, bSize);
    for (let index = 0; index < shared; index++) {
        const difference = (a[aOffset + index] as number) - (b[bOffset + index] as number);
        if (difference !== 0) return difference;
    }
    return aSize - bSize;
}

interface Cursor {
    readonly size: number;
    readonly data: Uint8Array;
    offset: number;
}

/** Visits every prefix in the list's one sorted order, across lengths, which removal indices and the checksum use. */
function forEachSorted(
    groups: ReadonlyMap<number, Uint8Array>,
    visit: (size: number, data: Uint8Array, offset: number) => void,
): void {
    const cursors: Cursor[] = [...groups]
        .filter(([, data]) => data.length > 0)
        .map(([size, data]) => ({ size, data, offset: 0 }));
    while (cursors.length > 0) {
        let least = cursors[0] as Cursor;
        for (const cursor of cursors) {
            if (compare(cursor.data, cursor.offset, cursor.size, least.data, least.offset, least.size) < 0) {
                least = cursor;
            }
        }
        visit(least.size, least.data, least.offset);
        least.offset += least.size;
        if (least.offset >= least.data.length) cursors.splice(cursors.indexOf(least), 1);
    }
}

export function hashListSize(list: HashPrefixList): number {
    let total = 0;
    for (const [size, data] of list.groups) total += data.length / size;
    return total;
}

/** Sorts packed fixed-size entries; 4-byte prefixes as big-endian integers, which is the same order and far faster. */
function sortPacked(size: number, data: Uint8Array): Uint8Array {
    const count = data.length / size;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (size === 4) {
        const values = new Uint32Array(count);
        for (let index = 0; index < count; index++) values[index] = view.getUint32(index * 4);
        values.sort();
        const sorted = new Uint8Array(data.length);
        const out = new DataView(sorted.buffer);
        for (let index = 0; index < count; index++) out.setUint32(index * 4, values[index] as number);
        return sorted;
    }
    const entries = Array.from({ length: count }, (_, index) => data.subarray(index * size, (index + 1) * size));
    entries.sort((a, b) => compare(a, 0, size, b, 0, size));
    const sorted = new Uint8Array(data.length);
    for (const [index, entry] of entries.entries()) sorted.set(entry, index * size);
    return sorted;
}

async function checksumOf(groups: ReadonlyMap<number, Uint8Array>): Promise<Uint8Array> {
    let total = 0;
    for (const data of groups.values()) total += data.length;
    const all = new Uint8Array(total);
    let at = 0;
    forEachSorted(groups, (size, data, offset) => {
        all.set(data.subarray(offset, offset + size), at);
        at += size;
    });
    return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && compare(a, 0, a.length, b, 0, b.length) === 0;
}

/**
 * The list after `update`, or null when the update does not fit the list (a removal index out of range, an addition of
 * an impossible length) or the result does not match Google's checksum. Either way the caller starts over from an
 * empty list, as the Update API asks.
 */
export async function applyHashListUpdate(
    list: HashPrefixList,
    update: HashListUpdate,
): Promise<HashPrefixList | null> {
    const base = update.kind === 'reset' ? EMPTY_HASH_LIST : list;
    const removals = new Set(update.removals);
    if (removals.size !== update.removals.length) return null;
    const total = hashListSize(base);
    for (const index of removals) {
        if (!Number.isInteger(index) || index < 0 || index >= total) return null;
    }
    const kept = new Map<number, number[]>();
    let position = 0;
    forEachSorted(base.groups, (size, _, offset) => {
        if (!removals.has(position)) {
            const offsets = kept.get(size) ?? [];
            offsets.push(offset);
            kept.set(size, offsets);
        }
        position++;
    });
    const added = new Map<number, Uint8Array[]>();
    for (const addition of update.additions) {
        const { prefixSize, hashes } = addition;
        if (prefixSize < MIN_PREFIX_BYTES || prefixSize > MAX_PREFIX_BYTES || hashes.length % prefixSize !== 0) {
            return null;
        }
        added.set(prefixSize, [...(added.get(prefixSize) ?? []), hashes]);
    }
    const groups = new Map<number, Uint8Array>();
    for (const size of new Set([...kept.keys(), ...added.keys()])) {
        const offsets = kept.get(size) ?? [];
        const additions = added.get(size) ?? [];
        const source = base.groups.get(size);
        const packed = new Uint8Array(
            offsets.length * size + additions.reduce((sum, hashes) => sum + hashes.length, 0),
        );
        let at = 0;
        for (const offset of offsets) {
            packed.set((source as Uint8Array).subarray(offset, offset + size), at);
            at += size;
        }
        for (const hashes of additions) {
            packed.set(hashes, at);
            at += hashes.length;
        }
        if (packed.length > 0) groups.set(size, sortPacked(size, packed));
    }
    return sameBytes(await checksumOf(groups), update.checksum) ? { groups } : null;
}

/** The list's prefixes that `fullHash` (a SHA-256) starts with; usually none. */
export function matchingPrefixes(list: HashPrefixList, fullHash: Uint8Array): readonly Uint8Array[] {
    const found: Uint8Array[] = [];
    for (const [size, data] of list.groups) {
        let low = 0;
        let high = data.length / size - 1;
        while (low <= high) {
            const middle = (low + high) >>> 1;
            const order = compare(data, middle * size, size, fullHash, 0, size);
            if (order === 0) {
                found.push(data.slice(middle * size, (middle + 1) * size));
                break;
            }
            if (order < 0) low = middle + 1;
            else high = middle - 1;
        }
    }
    return found;
}

const ENCODING_VERSION = 1;

/** One byte array for storage: a version, then per group its prefix length (1 byte), byte length (4) and bytes. */
export function encodeHashList(list: HashPrefixList): Uint8Array {
    let total = 1;
    for (const data of list.groups.values()) total += 5 + data.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out[0] = ENCODING_VERSION;
    let at = 1;
    for (const [size, data] of list.groups) {
        view.setUint8(at, size);
        view.setUint32(at + 1, data.length);
        out.set(data, at + 5);
        at += 5 + data.length;
    }
    return out;
}

/** The list {@link encodeHashList} wrote; null for bytes it could not have written. */
export function decodeHashList(bytes: Uint8Array): HashPrefixList | null {
    if (bytes[0] !== ENCODING_VERSION) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const groups = new Map<number, Uint8Array>();
    let at = 1;
    while (at < bytes.length) {
        if (at + 5 > bytes.length) return null;
        const size = view.getUint8(at);
        const length = view.getUint32(at + 1);
        at += 5;
        if (size < MIN_PREFIX_BYTES || size > MAX_PREFIX_BYTES || length % size !== 0 || groups.has(size)) return null;
        if (at + length > bytes.length) return null;
        groups.set(size, bytes.slice(at, at + length));
        at += length;
    }
    return { groups };
}
