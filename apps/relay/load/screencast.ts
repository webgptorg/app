/**
 * Scenarios 3 and 4. This process plays the engines: each holds a tunnel, terminates TLS inside its streams with the
 * engines' own key and serves WebSocket screencasts. The browsers run in a child process (screencast-browsers.ts), so
 * neither side's event loop delays the other's timestamps; both stamp with the same wall clock.
 */
import { fork } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { cellName, enginesFor, parseCells } from './lib/cells';
import { createEngineServer } from './lib/engine-server';
import { startFleet } from './lib/fleet';
import { RELAY_HOST, loadEngines } from './lib/fixtures';
import { log, parseOptions, sleep, writeResult } from './lib/output';
import type { BrowsersPlan, BrowsersResult } from './screencast-browsers';

const DEFAULT_CELLS = [
    '100kx5x1@600',
    '50kx5x1',
    '50kx10x1',
    '100kx10x1',
    '200kx5x1',
    '200kx10x1',
    '50kx5x20',
    '50kx10x20',
    '100kx5x20',
    '100kx10x20',
    '200kx5x20',
    '200kx10x20',
    'fair@600',
].join(',');

const options = parseOptions(
    { offset: 5000, 'cell-s': 180, 'warmup-s': 30 },
    { cells: DEFAULT_CELLS, label: 'screencast' },
);
const cells = parseCells(options.cells, options['cell-s']);
const engines = await loadEngines(options.offset, Math.max(...cells.map(enginesFor)));
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

const server = await createEngineServer();
const fleet = await startFleet({
    engines,
    rampMs: 0,
    label: options.label,
    onStream: (_engine, stream) => {
        server.handle(stream);
    },
});
await fleet.allReady();
log('screencast.engines-ready', { engines: engines.length, cells: cells.map(cellName) });

const plan: BrowsersPlan = {
    relayHost: RELAY_HOST,
    hostnames: engines.map((engine) => engine.hostname),
    cells,
    warmupMs: options['warmup-s'] * 1000,
};
const browsers = fork(fileURLToPath(new URL('./screencast-browsers.ts', import.meta.url)), [], {
    serialization: 'advanced',
});
const result = await new Promise<BrowsersResult>((resolve, reject) => {
    browsers.once('message', (message) => {
        resolve(message as BrowsersResult);
    });
    browsers.once('exit', (code) => {
        reject(new Error(`browser process exited with ${String(code)}`));
    });
    browsers.send(plan);
});
const report = fleet.stats.report(engines.length);
fleet.stop();
server.close();

writeResult(`${options.label}.json`, {
    scenario: 'screencast',
    engines: engines.length,
    warmupSeconds: options['warmup-s'],
    engineLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
    engineTunnelsLost: report.lost,
    browserLoopDelayP99Ms: result.loopDelayP99Ms,
    cells: result.cells,
});
log('screencast.done', { cells: result.cells.length, tunnelsLost: report.lost });
await sleep(1000);
process.exit(0);
