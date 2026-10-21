import type { EngineVersion, Timestamp } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { DashboardApi, DashboardProblem } from '../dashboard/dashboard-api';
import type { EngineIdentity } from '../identity/engine-identity';
import { signerOf } from '../identity/engine-identity';
import type { Logger } from '../logger';
import { buildSignedHeartbeat, isoSeconds } from './build-heartbeat';
import type { EngineStatsSource } from './engine-stats-source';
import type { SeqStore } from './seq-store';
import type { SystemStats } from './system-stats';

export const DEFAULT_HEARTBEAT_INTERVAL_S = 60;
const STALE_TIMESTAMP_CODE = 'stale-timestamp';

export interface LastHeartbeat {
    readonly sentAt: Timestamp;
    /** The exact text sent, byte for byte. */
    readonly body: string;
    /** The exact `Ptbk-Signature` header value sent with it. */
    readonly signature: string;
}

export interface ClockSkew {
    /** Local clock minus the dashboard's `serverTime`: negative when the engine's clock is behind. */
    readonly seconds: number;
    readonly measuredAt: Timestamp;
}

/** What the owner sees about the heartbeat: everything the dashboard learns, and whether our clock is off. */
export interface HeartbeatStatus {
    readonly lastHeartbeat: LastHeartbeat | null;
    /** Null while unknown: no stale-timestamp answer, one without `serverTime`, or accepted since. */
    readonly clockSkew: ClockSkew | null;
}

export interface HeartbeatLoopDeps {
    readonly clock: Clock;
    readonly logger: Logger;
    readonly api: DashboardApi;
    readonly seqs: SeqStore;
    readonly system: SystemStats;
    readonly engine: EngineStatsSource;
    readonly identity: EngineIdentity;
    readonly version: EngineVersion;
    readonly intervalS: number;
    readonly startedAtMs: number;
    /** Every change of the status (each body as it goes out, each skew measured or cleared), for the security panel. */
    readonly onStatus?: (status: HeartbeatStatus) => void;
}

export interface HeartbeatLoop {
    /** Sends the first beat now, then one every interval. */
    start(): void;
    /** Stops the timer and aborts a beat in flight. */
    stop(): Promise<void>;
    status(): HeartbeatStatus;
}

/**
 * One signed beat per interval, driven by the `Clock`. A failed send is logged with its status code only and not
 * retried; a missed beat is not backfilled, and a beat still in flight when the next one is due makes that one skip.
 * The `seq` is persisted before the body is built, so a crash or an unreachable dashboard never reuses one.
 */
export function createHeartbeatLoop(deps: HeartbeatLoopDeps): HeartbeatLoop {
    const { clock, logger } = deps;
    const intervalMs = deps.intervalS * 1000;
    const signer = signerOf(deps.identity);
    let status: HeartbeatStatus = Object.freeze({ lastHeartbeat: null, clockSkew: null });
    let cancelTimer: (() => void) | null = null;
    let inFlight: Promise<void> | null = null;
    let abort = new AbortController();

    function setStatus(patch: Partial<HeartbeatStatus>): void {
        status = Object.freeze({ ...status, ...patch });
        deps.onStatus?.(status);
    }

    function recordSkew(problem: DashboardProblem | null): void {
        if (problem?.code !== STALE_TIMESTAMP_CODE) return;
        if (problem.serverTime === null) {
            setStatus({ clockSkew: null });
            return;
        }
        const nowMs = clock.nowMs();
        const seconds = Math.round((nowMs - Date.parse(problem.serverTime)) / 1000);
        setStatus({ clockSkew: Object.freeze({ seconds, measuredAt: isoSeconds(nowMs) }) });
        logger.warn('heartbeat.clock-skew', { seconds });
    }

    async function beat(signal: AbortSignal): Promise<void> {
        const seq = await deps.seqs.next();
        const signed = await buildSignedHeartbeat(
            {
                engineId: deps.identity.engineId,
                seq,
                version: deps.version,
                startedAtMs: deps.startedAtMs,
                system: await deps.system.sample(),
                counts: deps.engine.counts(),
                update: deps.engine.updateState(),
            },
            { clock, signer, signal },
        );
        // Recorded before the answer: once the request leaves, the dashboard may have the body whatever it answers.
        setStatus({
            lastHeartbeat: Object.freeze({ sentAt: signed.ts, body: signed.body, signature: signed.signature }),
        });
        const result = await deps.api.heartbeat(deps.identity.engineId, signed.rawBody, signed.signature, signal);
        switch (result.kind) {
            case 'accepted':
                setStatus({ clockSkew: null });
                return;
            case 'refused':
                logger.warn('heartbeat.refused', { status: result.status });
                recordSkew(result.problem);
                return;
            case 'unavailable':
                logger.warn('heartbeat.unavailable', {});
                return;
        }
    }

    function tick(): void {
        cancelTimer = clock.setTimeout(tick, intervalMs);
        if (inFlight !== null) {
            logger.warn('heartbeat.skipped', {});
            return;
        }
        const signal = abort.signal;
        inFlight = beat(signal)
            .catch((error: unknown) => {
                if (signal.aborted) return;
                logger.error('heartbeat.failed', { problem: error instanceof Error ? error.name : 'unknown' });
            })
            .finally(() => {
                inFlight = null;
            });
    }

    return {
        start() {
            if (cancelTimer === null) tick();
        },
        async stop() {
            cancelTimer?.();
            cancelTimer = null;
            abort.abort();
            await inFlight;
            abort = new AbortController();
        },
        status: () => status,
    };
}
