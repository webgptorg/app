/**
 * Scenario 1 (and the background of 2 and 3): N engines hold idle tunnels with normal pings. Reports how long it took
 * until all were ready, handshake times, rejects, reconnects and every loss of a ready tunnel.
 *
 * `--hold-s 0` holds until SIGTERM, for the orchestrator's reconnect storm and as background load.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { startFleet } from './lib/fleet';
import { loadEngines } from './lib/fixtures';
import { log, parseOptions, sleep, writeResult } from './lib/output';

const options = parseOptions(
    { tunnels: 1000, offset: 0, 'hold-s': 600, 'ramp-s': 0, 'establish-timeout-s': 900 },
    { label: 'idle' },
);
const engines = await loadEngines(options.offset, options.tunnels);
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

const startedAt = Date.now();
log('idle.start', { tunnels: engines.length, label: options.label });
const fleet = await startFleet({ engines, rampMs: options['ramp-s'] * 1000, label: options.label });
const allReadyAt = await Promise.race([
    fleet.allReady(),
    sleep(options['establish-timeout-s'] * 1000).then(() => null),
]);
log('idle.established', {
    connected: fleet.stats.snapshot(engines.length).connected,
    seconds: allReadyAt === null ? null : (allReadyAt - startedAt) / 1000,
});

const stopRequested = new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
});
const holdStart = Date.now();
await (options['hold-s'] === 0 ? stopRequested : Promise.race([stopRequested, sleep(options['hold-s'] * 1000)]));
const holdEnd = Date.now();
const report = fleet.stats.report(engines.length);
fleet.stop();

writeResult(`${options.label}.json`, {
    scenario: 'idle',
    tunnels: engines.length,
    startedAt,
    allReadyAt,
    establishSeconds: allReadyAt === null ? null : (allReadyAt - startedAt) / 1000,
    holdStart,
    holdEnd,
    connectedAtEnd: report.connected,
    lostDuringHold: report.lostTimes.filter((time) => time >= holdStart).length,
    generatorLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
    report,
});
log('idle.done', { connectedAtEnd: report.connected, lost: report.lost, rejects: report.rejects });
// Close frames are on their way; give them a moment before the process (and the sockets) go.
await sleep(1000);
process.exit(0);
