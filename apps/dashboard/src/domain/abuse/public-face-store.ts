import type { EngineId, Hostname } from '@ptbk/protocol';

import type { PublicFaceResult } from './public-face';

/** A `public_face_checks` row. */
export interface PublicFaceRecord {
    readonly engineId: EngineId;
    readonly checkedAt: number;
    readonly result: PublicFaceResult;
    readonly fingerprint: string | null;
}

export interface DueEngine {
    readonly engineId: EngineId;
    readonly hostname: Hostname;
}

/** The public-face check's state in D1. */
export interface PublicFaceStore {
    /** Active engines, never checked first, then the longest unchecked; at most `limit`. */
    due(limit: number): Promise<readonly DueEngine[]>;
    record(checks: readonly PublicFaceRecord[]): Promise<void>;
    /** Active engines without a check at or after `since`. */
    countUncheckedSince(since: number): Promise<number>;
    /** Forgets checks before `before`. */
    prune(before: number): Promise<void>;
}
