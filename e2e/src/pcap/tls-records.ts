export interface TlsRecord {
    readonly contentType: number;
    /** The record-layer version as one 16-bit value, e.g. 0x0303. */
    readonly version: number;
    /** Payload length, excluding the 5-byte header. */
    readonly length: number;
    readonly offset: number;
}

export type TlsMalformedReason = 'content-type' | 'version' | 'length';

export type TlsScanOutcome =
    | { readonly kind: 'records' }
    | { readonly kind: 'truncated'; readonly offset: number }
    | { readonly kind: 'malformed'; readonly offset: number; readonly reason: TlsMalformedReason };

export interface TlsRecordScan {
    /** The complete, well-formed records before the outcome's offset. */
    readonly records: readonly TlsRecord[];
    readonly outcome: TlsScanOutcome;
}

export interface TlsStreamCheckOptions {
    /** Accept a stream that ends inside a record whose header bytes so far are valid, as a stopped capture does. */
    readonly allowTruncatedTail?: boolean;
}

export interface TlsContentTypeCounts {
    readonly changeCipherSpec: number;
    readonly alert: number;
    readonly handshake: number;
    readonly applicationData: number;
}

export type TlsStreamProblemReason = TlsMalformedReason | 'empty' | 'truncated' | 'after-application-data';

export interface TlsStreamProblem {
    readonly reason: TlsStreamProblemReason;
    readonly offset: number;
    /** Offsets and limits only, never stream content, so it is safe to print. */
    readonly description: string;
}

export type TlsStreamCheck =
    | { readonly kind: 'tls'; readonly counts: TlsContentTypeCounts; readonly truncatedTail: boolean }
    | { readonly kind: 'invalid'; readonly counts: TlsContentTypeCounts; readonly problem: TlsStreamProblem };

const HEADER_BYTES = 5;
// RFC 8446 caps ciphertext at 2^14 + 256; 2^14 + 2048 is the TLS 1.2 limit and stays valid for older peers.
const MAX_RECORD_LENGTH = 2 ** 14 + 2048;
const CHANGE_CIPHER_SPEC = 20;
const ALERT = 21;
const HANDSHAKE = 22;
const APPLICATION_DATA = 23;

/** Walks the record layer of a TLS byte stream, stopping at the first malformed header or incomplete record. */
export function scanTlsRecords(bytes: Uint8Array): TlsRecordScan {
    const records: TlsRecord[] = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
        const header = bytes.subarray(offset, offset + HEADER_BYTES);
        const reason = headerProblem(header);
        if (reason !== undefined) return { records, outcome: { kind: 'malformed', offset, reason } };
        const [contentType, major, minor, lengthHigh, lengthLow] = header;
        if (
            contentType === undefined ||
            major === undefined ||
            minor === undefined ||
            lengthHigh === undefined ||
            lengthLow === undefined
        ) {
            return { records, outcome: { kind: 'truncated', offset } };
        }
        const length = (lengthHigh << 8) | lengthLow;
        if (offset + HEADER_BYTES + length > bytes.byteLength)
            return { records, outcome: { kind: 'truncated', offset } };
        records.push({ contentType, version: (major << 8) | minor, length, offset });
        offset += HEADER_BYTES + length;
    }
    return { records, outcome: { kind: 'records' } };
}

/**
 * Whether a stream is nothing but well-formed TLS records, with only application data once application data started.
 * That is what TLS 1.3 looks like on the wire: post-handshake messages, alerts and close_notify travel as type 23.
 */
export function checkTlsStream(bytes: Uint8Array, options: TlsStreamCheckOptions = {}): TlsStreamCheck {
    const { records, outcome } = scanTlsRecords(bytes);
    const counts = countContentTypes(records);
    const firstApplicationData = records.findIndex((record) => record.contentType === APPLICATION_DATA);
    const late =
        firstApplicationData < 0
            ? undefined
            : records.slice(firstApplicationData).find((record) => record.contentType !== APPLICATION_DATA);
    if (late !== undefined) return invalid(counts, 'after-application-data', late.offset);
    switch (outcome.kind) {
        case 'malformed':
            return invalid(counts, outcome.reason, outcome.offset);
        case 'truncated':
            if (options.allowTruncatedTail !== true) return invalid(counts, 'truncated', outcome.offset);
            break;
        case 'records':
            break;
    }
    if (records.length === 0) return invalid(counts, 'empty', 0);
    return { kind: 'tls', counts, truncatedTail: outcome.kind === 'truncated' };
}

/** Checks whichever header bytes are present, so a stream cut inside a header is still judged on what it has. */
function headerProblem(header: Uint8Array): TlsMalformedReason | undefined {
    const [contentType, major, minor, lengthHigh, lengthLow] = header;
    if (contentType !== undefined && (contentType < CHANGE_CIPHER_SPEC || contentType > APPLICATION_DATA)) {
        return 'content-type';
    }
    if (major !== undefined && major !== 3) return 'version';
    if (minor !== undefined && (minor < 1 || minor > 4)) return 'version';
    if (lengthHigh !== undefined) {
        const length = (lengthHigh << 8) | (lengthLow ?? 0);
        if (length > MAX_RECORD_LENGTH || (lengthLow !== undefined && length < 1)) return 'length';
    }
    return undefined;
}

function countContentTypes(records: readonly TlsRecord[]): TlsContentTypeCounts {
    const count = (contentType: number): number =>
        records.filter((record) => record.contentType === contentType).length;
    return {
        changeCipherSpec: count(CHANGE_CIPHER_SPEC),
        alert: count(ALERT),
        handshake: count(HANDSHAKE),
        applicationData: count(APPLICATION_DATA),
    };
}

function invalid(counts: TlsContentTypeCounts, reason: TlsStreamProblemReason, offset: number): TlsStreamCheck {
    return { kind: 'invalid', counts, problem: { reason, offset, description: describe(reason, offset) } };
}

function describe(reason: TlsStreamProblemReason, offset: number): string {
    const at = `at offset ${String(offset)}`;
    switch (reason) {
        case 'content-type':
            return `record header ${at} has a content type outside 20-23`;
        case 'version':
            return `record header ${at} has a version outside 3.1-3.4`;
        case 'length':
            return `record header ${at} has a length outside 1-${String(MAX_RECORD_LENGTH)}`;
        case 'truncated':
            return `stream ends inside the record ${at}`;
        case 'after-application-data':
            return `record ${at} is not application data but follows application data`;
        case 'empty':
            return 'stream holds no complete TLS record';
    }
}
