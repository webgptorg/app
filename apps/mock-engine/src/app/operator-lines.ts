import type { EngineId, Hostname } from '@ptbk/protocol';
import { deriveEngineFingerprint } from '@ptbk/protocol';

/** Human lines for the operator's terminal; the log stream gets structured events instead. */
export type Say = (line: string) => void;

export const DONE = '✓';
export const FAILED = '✗';
export const WAITING = '…';

/** The engine's identity as the dashboard shows it, so the operator can compare the fingerprint before trusting it. */
export function identityLines(engineId: EngineId, hostname: Hostname): readonly string[] {
    return [
        `        Engine ID     ${engineId}`,
        `        Address       https://${hostname}`,
        `        Fingerprint   ${deriveEngineFingerprint(engineId).formatted}   (the dashboard shows the same)`,
    ];
}
