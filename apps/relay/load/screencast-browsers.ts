/**
 * The browser side of the screencast scenario, forked by screencast.ts: runs the cells one after another through the
 * relay and measures what arrives. Latency is the frame's wall-clock stamp from the engine process subtracted from
 * this process's wall clock on arrival, on the same host.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { BrowserStream, BrowserTarget } from './lib/browser';
import { openBulk, openScreencast } from './lib/browser';
import type { Cell } from './lib/cells';
import { FAIRNESS_FPS, FAIRNESS_FRAME_BYTES, cellName } from './lib/cells';
import { RELAY_PORT, engineTrust } from './lib/fixtures';
import { log, sleep } from './lib/output';
import type { Percentiles } from './lib/stats';
import { percentiles } from './lib/stats';

export interface BrowsersPlan {
    readonly relayHost: string;
    readonly hostnames: readonly string[];
    readonly cells: readonly Cell[];
    readonly warmupMs: number;
}

export interface StreamResult {
    readonly fps: number;
    readonly frames: number;
    readonly payloadBytes: number;
    readonly droppedByEngine: number;
}

export interface CellResult {
    readonly name: string;
    readonly cell: Cell;
    /** Wall-clock window measured, after warm-up. */
    readonly measureStart: number;
    readonly measureEnd: number;
    readonly openFailures: number;
    /** Streams that closed before the cell ended. */
    readonly closedEarly: number;
    readonly screencast: {
        readonly streams: readonly StreamResult[];
        readonly fpsMin: number;
        readonly fpsMean: number;
        readonly latencyMs: Percentiles;
        /** Application payload only; the report takes wire bytes from the relay's interface. */
        readonly payloadBytesPerHourPerStream: number;
    };
    /** Fairness only: what engine A's downloads achieved together. */
    readonly bulkBytesPerS: number | null;
}

export interface BrowsersResult {
    readonly cells: readonly CellResult[];
    readonly loopDelayP99Ms: number;
}

const BETWEEN_CELLS_MS = 5_000;

async function runCell(plan: BrowsersPlan, cell: Cell, target: (index: number) => BrowserTarget): Promise<CellResult> {
    const casts: BrowserStream[] = [];
    const bulks: BrowserStream[] = [];
    if (cell.kind === 'fairness') {
        for (let index = 0; index < cell.bulkStreams; index++) bulks.push(openBulk(target(0)));
        casts.push(openScreencast(target(1), FAIRNESS_FRAME_BYTES, FAIRNESS_FPS));
    } else {
        for (let index = 0; index < cell.streams; index++) {
            casts.push(openScreencast(target(index), cell.frameBytes, cell.fps));
        }
    }
    const all = [...casts, ...bulks];
    const opened = await Promise.allSettled(all.map((stream) => stream.opened));
    const openFailures = opened.filter((outcome) => outcome.status === 'rejected').length;
    let closedEarly = 0;
    let ending = false;
    for (const stream of all) {
        void stream.closed.then(() => {
            if (!ending) closedEarly++;
        });
    }
    await sleep(plan.warmupMs);
    for (const stream of all) stream.meter.measuring = true;
    const measureStart = Date.now();
    await sleep(cell.seconds * 1000);
    for (const stream of all) stream.meter.measuring = false;
    const measureEnd = Date.now();
    ending = true;
    for (const stream of all) stream.close();
    await Promise.race([Promise.all(all.map((stream) => stream.closed)), sleep(5000)]);

    const seconds = (measureEnd - measureStart) / 1000;
    const streams = casts.map(({ meter }): StreamResult => ({
        fps: meter.frames / seconds,
        frames: meter.frames,
        payloadBytes: meter.bytes,
        droppedByEngine: meter.droppedAtEnd - (meter.droppedAtStart ?? meter.droppedAtEnd),
    }));
    const fps = streams.map((stream) => stream.fps);
    const payload = streams.reduce((sum, stream) => sum + stream.payloadBytes, 0);
    return {
        name: cellName(cell),
        cell,
        measureStart,
        measureEnd,
        openFailures,
        closedEarly,
        screencast: {
            streams,
            fpsMin: Math.min(...fps),
            fpsMean: fps.reduce((sum, value) => sum + value, 0) / Math.max(1, fps.length),
            latencyMs: percentiles(casts.flatMap(({ meter }) => meter.latenciesMs)),
            payloadBytesPerHourPerStream: (payload / Math.max(1, casts.length) / seconds) * 3600,
        },
        bulkBytesPerS:
            cell.kind === 'fairness' ? bulks.reduce((sum, { meter }) => sum + meter.bytes, 0) / seconds : null,
    };
}

async function run(plan: BrowsersPlan): Promise<BrowsersResult> {
    const trust = await engineTrust();
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const target = (index: number): BrowserTarget => {
        const hostname = plan.hostnames[index];
        if (hostname === undefined) throw new RangeError('not enough engines for this cell');
        return { relayHost: plan.relayHost, relayPort: RELAY_PORT, hostname, trust };
    };
    const cells: CellResult[] = [];
    for (const cell of plan.cells) {
        log('screencast.cell', { cell: cellName(cell), seconds: cell.seconds });
        const result = await runCell(plan, cell, target);
        log('screencast.cell-done', {
            cell: result.name,
            fpsMin: Number(result.screencast.fpsMin.toFixed(2)),
            p50: Number(result.screencast.latencyMs.p50.toFixed(1)),
            p95: Number(result.screencast.latencyMs.p95.toFixed(1)),
            p99: Number(result.screencast.latencyMs.p99.toFixed(1)),
            bulkMBps: result.bulkBytesPerS === null ? null : Number((result.bulkBytesPerS / 1e6).toFixed(2)),
            openFailures: result.openFailures,
            closedEarly: result.closedEarly,
        });
        cells.push(result);
        await sleep(BETWEEN_CELLS_MS);
    }
    return { cells, loopDelayP99Ms: loopDelay.percentile(99) / 1e6 };
}

process.once('message', (message) => {
    void run(message as BrowsersPlan).then((result) => {
        process.send?.(result, () => {
            process.exit(0);
        });
    });
});
