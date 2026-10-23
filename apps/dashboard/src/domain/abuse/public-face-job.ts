import type { Hostname } from '@ptbk/protocol';

import { mapConcurrently } from '../engines/map-concurrently';
import type { MonitorStore } from '../monitoring/monitor-store';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import { checkPublicFace, type PublicFaceFetcher } from './public-face';
import type { PublicFaceRecord, PublicFaceStore } from './public-face-store';

const DAY_MS = 24 * 60 * 60 * 1000;
export const PUBLIC_FACE_RETENTION_MS = 30 * DAY_MS;

export interface PublicFaceSettings {
    /** Fingerprints of the engine sign-in pages we know. */
    readonly fingerprints: ReadonlySet<string>;
    /** Engines per run: every run spends up to 1 + redirects subrequests per engine. */
    readonly perRun: number;
    readonly concurrency: number;
    readonly timeoutMs: number;
}

export interface PublicFaceJobDeps {
    readonly engineDomain: Hostname;
    readonly fetcher: PublicFaceFetcher;
    readonly store: PublicFaceStore;
    readonly monitor: Pick<MonitorStore, 'track'>;
    readonly settings: PublicFaceSettings;
    readonly clock: Clock;
    readonly logger: Logger;
}

/**
 * The public-face check (I-05): each run visits the engines checked longest ago, so with runs every 15 minutes every
 * active engine is seen at least daily while there are at most 96 × `perRun` of them (`public-face.behind` says when
 * not). A mismatch alerts the abuse inbox and nothing more: never an automatic suspension, since a modified engine can
 * show us a clean page and a broken one can show us an odd one. Only results and fingerprints are stored.
 */
export async function runPublicFaceCheck(deps: PublicFaceJobDeps, signal: AbortSignal): Promise<void> {
    const at = deps.clock.nowMs();
    const { settings } = deps;
    const suffix = `.${deps.engineDomain}`;
    // Defence in depth: only default hostnames under the engine domain are ever visited.
    const due = (await deps.store.due(settings.perRun)).filter((engine) => engine.hostname.endsWith(suffix));
    const records = await mapConcurrently(due, settings.concurrency, async (engine): Promise<PublicFaceRecord> => {
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]);
        const check = await checkPublicFace(
            { fetcher: deps.fetcher, fingerprints: settings.fingerprints },
            engine.hostname,
            timeout,
        );
        return { engineId: engine.engineId, checkedAt: at, ...check };
    });
    await deps.store.record(records);
    await deps.monitor.track(
        'public-face-mismatch',
        records.map((record) => ({
            subject: record.engineId,
            // Unreachable says nothing about the page: an open alert stays open, none starts.
            firing: record.result === 'unreachable' ? null : record.result === 'mismatch',
            detail: {},
        })),
        at,
    );
    await deps.store.prune(at - PUBLIC_FACE_RETENTION_MS);
    const behind = await deps.store.countUncheckedSince(at - DAY_MS);
    if (behind > 0) deps.logger.warn('public-face.behind', { engines: behind });
    deps.logger.info('public-face.run', {
        checked: records.length,
        mismatch: records.filter((record) => record.result === 'mismatch').length,
        unreachable: records.filter((record) => record.result === 'unreachable').length,
    });
}
