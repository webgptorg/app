import type { EngineId, Hostname } from '@ptbk/protocol';

/** Hostnames per `listed` call; lookup APIs take batches of about this size. */
export const ABUSE_FEED_BATCH = 500;

/**
 * A phishing or malware list (I-05). Which providers back it is the team's choice (plan, "Still needed"); each one is an
 * adapter of this port, and none is wired until one is chosen.
 */
export interface AbuseFeed {
    /** Stable and dashed, e.g. `web-risk`; it names the feed in logs. */
    readonly name: string;
    /** Which of `hostnames` (at most {@link ABUSE_FEED_BATCH}) the feed lists now. */
    listed(hostnames: readonly Hostname[], signal: AbortSignal): Promise<ReadonlySet<Hostname>>;
}

export interface ActiveEngine {
    readonly engineId: EngineId;
    readonly hostname: Hostname;
}

/** The engines whose default hostnames are looked up. */
export interface ActiveEngineDirectory {
    /** Active engines, by engine ID, at most `limit`. */
    list(limit: number): Promise<readonly ActiveEngine[]>;
}
