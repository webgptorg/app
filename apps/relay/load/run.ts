/**
 * Runs R-05's scenarios against the containerised relay, one command each, and writes everything a report needs into
 * `load/results/<time>-<scenario>/`: the relay's samples (CSV, every 5 s), `docker stats` (CSV), the generator's
 * results (JSON), the relay's logs, and `summary.md` with the tables. Runs on the host; needs Docker Compose.
 *
 *   tsx load/run.ts idle        [--tunnels 1000,2000,5000] [--hold-s 600] [--storm-tunnels 1000] [--storm-hold-s 300]
 *   tsx load/run.ts screencast  [--background 1000] [--cells ...] [--cell-s 180] [--warmup-s 30]
 *   tsx load/run.ts worst-case  [--connections 4000] [--raised-connections 8000] [--flood 10000] [--hold-s 120]
 */
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { CellResult } from './screencast-browsers';
import type { Sample } from './lib/samples';
import { averageRate, cpuPercent, maxOf, medianOf, peakCpuPercent, readSamples, within } from './lib/samples';

const LOAD_DIR = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(LOAD_DIR, 'docker-compose.load.yml');
const PROJECT = 'ptbk-load';
const BASELINE_MS = 30_000;
const STEADY_SKIP_MS = 60_000;
const MIB = 1_048_576;

const [scenario = '', ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
    args: rest,
    options: {
        tunnels: { type: 'string', default: '1000,2000,5000' },
        'hold-s': { type: 'string' },
        'storm-tunnels': { type: 'string', default: '1000' },
        'fast-establish': { type: 'string', default: '5000' },
        'storm-hold-s': { type: 'string', default: '300' },
        background: { type: 'string', default: '1000' },
        cells: { type: 'string' },
        'cell-s': { type: 'string', default: '180' },
        'warmup-s': { type: 'string', default: '30' },
        connections: { type: 'string', default: '4000' },
        'raised-connections': { type: 'string', default: '8000' },
        step: { type: 'string', default: '500' },
        flood: { type: 'string', default: '10000' },
        'plateau-s': { type: 'string', default: '45' },
        'skip-build': { type: 'boolean', default: false },
    },
    strict: true,
});

function num(value: string | undefined, fallback: number): number {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || parsed < 0) throw new RangeError(`not a number: ${String(value)}`);
    return parsed;
}

const runDir = join(LOAD_DIR, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}-${scenario}`);
mkdirSync(runDir, { recursive: true });
const summary: string[] = [];
const summaryJson: Record<string, unknown> = {};

function note(line = ''): void {
    summary.push(line);
    process.stdout.write(`${line}\n`);
}

function composeEnv(label: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        LOAD_RESULTS_DIR: runDir,
        LOAD_LABEL: label,
        LOAD_RELAY_ENV_FILE: join(runDir, `${label}.env`),
    };
}

interface Spawned {
    readonly child: ChildProcess;
    readonly exited: Promise<number>;
}

function compose(args: readonly string[], label: string, logFile?: string, extraEnv: NodeJS.ProcessEnv = {}): Spawned {
    const child = spawn('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, ...args], {
        env: { ...composeEnv(label), ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const file = logFile === undefined ? null : createWriteStream(join(runDir, logFile), { flags: 'a' });
    child.stdout.on('data', (chunk: Buffer) => {
        file?.write(chunk);
        if (logFile === undefined || !logFile.endsWith('.relay.log')) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
        file?.write(chunk);
        process.stderr.write(chunk);
    });
    const exited = new Promise<number>((resolve) => {
        child.once('exit', (code) => {
            file?.end();
            resolve(code ?? 1);
        });
    });
    return { child, exited };
}

async function mustCompose(args: readonly string[], label: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
    const code = await compose(args, label, undefined, extraEnv).exited;
    if (code !== 0) throw new Error(`docker compose ${args.join(' ')} failed with ${String(code)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(name: string): unknown {
    const path = join(runDir, name);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
        return null;
    }
}

/** `docker stats` for every container of the project, every 5 s: the generator's CPU shows it was not the limit. */
function startDockerStats(label: string): () => void {
    const file = createWriteStream(join(runDir, `${label}.docker-stats.csv`));
    file.write('time_ms,name,cpu_percent,mem_usage,net_io\n');
    const state = { running: true };
    void (async () => {
        while (state.running) {
            const started = Date.now();
            const output = await new Promise<string>((resolve) => {
                const child = spawn('docker', [
                    'stats',
                    '--no-stream',
                    '--format',
                    '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}}',
                ]);
                let text = '';
                child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
                child.once('exit', () => {
                    resolve(text);
                });
            });
            for (const line of output.split('\n')) {
                if (line.startsWith(`${PROJECT}-`)) file.write(`${String(started)},${line.replace(/%/g, '')}\n`);
            }
            await sleep(Math.max(0, 5000 - (Date.now() - started)));
        }
        file.end();
    })();
    return () => {
        state.running = false;
    };
}

interface RelayRun {
    readonly label: string;
    readonly readyAt: number;
    readonly stopStats: () => void;
}

async function startRelay(label: string, overrides: Readonly<Record<string, string>> = {}, sampleMs = 5000) {
    writeFileSync(
        join(runDir, `${label}.env`),
        Object.entries(overrides)
            .map(([name, value]) => `${name}=${value}`)
            .join('\n') + '\n',
    );
    await mustCompose(['up', '-d', '--wait', '--force-recreate', 'relay'], label, {
        LOAD_SAMPLE_INTERVAL_MS: String(sampleMs),
    });
    const run: RelayRun = { label, readyAt: Date.now(), stopStats: startDockerStats(label) };
    // The idle relay's own footprint, before any load.
    await sleep(BASELINE_MS);
    return run;
}

/** Whether the kernel killed the relay for its memory cap (and how often it restarted), for the report. */
async function relayState(): Promise<string> {
    return new Promise((resolve) => {
        const child = spawn('docker', ['inspect', '--format', '{{json .State}}', `${PROJECT}-relay-1`]);
        let text = '';
        child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()));
        child.once('exit', () => {
            resolve(text.trim());
        });
    });
}

async function stopRelay(run: RelayRun): Promise<void> {
    run.stopStats();
    const state = await relayState();
    writeFileSync(join(runDir, `${run.label}.relay-state.json`), `${state}\n`);
    if (state.includes('"OOMKilled":true'))
        note(`**${run.label}: the relay was killed for exceeding its memory cap.**`);
    await compose(['logs', '--no-color', '--timestamps', 'relay'], run.label, `${run.label}.relay.log`).exited;
    await mustCompose(['rm', '--stop', '--force', 'relay'], run.label);
}

function generator(label: string, script: string, scriptArgs: readonly string[]): Spawned {
    return compose(
        [
            '--profile',
            'tools',
            'run',
            '--rm',
            '-T',
            '--name',
            `${PROJECT}-${label}`,
            'generator',
            `load/${script}`,
            '--label',
            label,
            ...scriptArgs,
        ],
        label,
        `${label}.generator.log`,
    );
}

async function runGenerator(label: string, script: string, scriptArgs: readonly string[]): Promise<void> {
    const code = await generator(label, script, scriptArgs).exited;
    if (code !== 0) throw new Error(`${script} failed with ${String(code)}`);
}

async function stopGenerator(label: string, spawned: Spawned): Promise<void> {
    await new Promise<void>((resolve) => {
        spawn('docker', ['kill', '--signal', 'SIGTERM', `${PROJECT}-${label}`]).once('exit', () => {
            resolve();
        });
    });
    await spawned.exited;
}

interface Status {
    readonly connected: number;
    readonly engines: number;
}

async function waitConnected(label: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const status = readJson(`${label}.status.json`) as Status | null;
        if (status !== null && status.connected === status.engines && status.engines > 0) return true;
        await sleep(250);
    }
    return false;
}

function samplesOf(label: string): Sample[] {
    return readSamples(join(runDir, `${label}.relay.csv`));
}

const mib = (bytes: number): string => (bytes / MIB).toFixed(1);
const kib = (bytes: number): string => (bytes / 1024).toFixed(1);
const fixed = (value: number, digits = 1): string => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a');

interface MemoryView {
    readonly rss: number;
    readonly heapUsed: number;
    readonly heapTotal: number;
    readonly external: number;
    readonly cgroup: number;
    readonly sock: number;
    /** Kernel TCP send and receive queues of the relay's sockets. */
    readonly tcpQueued: number;
    readonly fds: number;
}

function memoryOf(samples: readonly Sample[]): MemoryView {
    return {
        rss: medianOf(samples, 'rss_bytes'),
        heapUsed: medianOf(samples, 'heap_used_bytes'),
        heapTotal: medianOf(samples, 'heap_total_bytes'),
        external: medianOf(samples, 'external_bytes'),
        cgroup: medianOf(samples, 'cgroup_memory_bytes'),
        sock: medianOf(samples, 'cgroup_sock_bytes'),
        tcpQueued: medianOf(samples, 'tcp_tx_queue_bytes') + medianOf(samples, 'tcp_rx_queue_bytes'),
        fds: medianOf(samples, 'open_fds'),
    };
}

/** (loaded − baseline) / count, per memory view. */
function perConnection(loaded: MemoryView, baseline: MemoryView, count: number): MemoryView {
    const per = (key: keyof MemoryView): number => (loaded[key] - baseline[key]) / count;
    return {
        rss: per('rss'),
        heapUsed: per('heapUsed'),
        heapTotal: per('heapTotal'),
        external: per('external'),
        cgroup: per('cgroup'),
        sock: per('sock'),
        tcpQueued: per('tcpQueued'),
        fds: per('fds'),
    };
}

interface IdleResult {
    readonly tunnels: number;
    readonly startedAt: number;
    readonly allReadyAt: number | null;
    readonly establishSeconds: number | null;
    readonly holdStart: number;
    readonly holdEnd: number;
    readonly connectedAtEnd: number;
    readonly lostDuringHold: number;
    readonly generatorLoopDelayP99Ms: number;
    readonly report: {
        readonly attempts: number;
        readonly reconnects: number;
        readonly rejects: Record<string, number>;
        readonly dialFailures: Record<string, number>;
        readonly lost: Record<string, number>;
        readonly handshakeMs: { readonly p50: number; readonly p95: number; readonly max: number };
        readonly readyTimes: readonly number[];
        readonly lostTimes: readonly number[];
    };
}

async function idleScenario(): Promise<void> {
    const holdS = num(args['hold-s'], 600);
    note(`# Idle tunnels (hold ${String(holdS)} s after all are ready)`);
    note();
    note(
        '| Tunnels | Established in (s) | Handshake p50/p95 (ms) | Rejects | Lost during hold | RSS/tunnel (KiB) | Heap/tunnel (KiB) | cgroup mem/tunnel (KiB) | RSS total (MiB) | CPU at rest (% of a core) | Loop delay p99 max (ms) |',
    );
    note('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const rows: unknown[] = [];
    for (const tunnels of args.tunnels
        .split(',')
        .map(Number)
        .filter((value) => value > 0)) {
        const label = `idle-${String(tunnels)}`;
        const relay = await startRelay(label);
        await runGenerator(label, 'idle-tunnels.ts', ['--tunnels', String(tunnels), '--hold-s', String(holdS)]);
        await stopRelay(relay);
        const result = readJson(`${label}.json`) as IdleResult | null;
        if (result === null) throw new Error(`${label}: no result`);
        const samples = samplesOf(label);
        const baseline = memoryOf(within(samples, relay.readyAt, result.startedAt));
        const steadyFrom = result.holdStart + Math.min(STEADY_SKIP_MS, (result.holdEnd - result.holdStart) / 3);
        const steadySamples = within(samples, steadyFrom, result.holdEnd);
        const steady = memoryOf(steadySamples);
        const per = perConnection(steady, baseline, tunnels);
        const row = {
            tunnels,
            establishSeconds: result.establishSeconds,
            handshakeMs: result.report.handshakeMs,
            rejects: result.report.rejects,
            dialFailures: result.report.dialFailures,
            lostDuringHold: result.lostDuringHold,
            connectedAtEnd: result.connectedAtEnd,
            baseline,
            steady,
            perTunnel: per,
            cpuPercent: cpuPercent(steadySamples),
            loopDelayP99MaxMs: maxOf(steadySamples, 'loop_delay_p99_ms'),
            generatorLoopDelayP99Ms: result.generatorLoopDelayP99Ms,
        };
        rows.push(row);
        note(
            `| ${String(tunnels)} | ${fixed(result.establishSeconds ?? Number.NaN)} | ${fixed(result.report.handshakeMs.p50, 0)}/${fixed(result.report.handshakeMs.p95, 0)} | ${JSON.stringify(result.report.rejects)} | ${String(result.lostDuringHold)} | ${kib(per.rss)} | ${kib(per.heapUsed)} | ${kib(per.cgroup)} | ${mib(steady.rss)} | ${fixed(row.cpuPercent, 2)} | ${fixed(row.loopDelayP99MaxMs)} |`,
        );
    }
    summaryJson['idle'] = rows;
    await fastEstablish();
    await stormScenario();
}

/** How fast the relay itself can take handshakes once the registry-miss budget is out of the way (a static file). */
async function fastEstablish(): Promise<void> {
    const tunnels = num(args['fast-establish'], 5000);
    if (tunnels === 0) return;
    const label = `establish-${String(tunnels)}-unpaced`;
    const relay = await startRelay(label, { RELAY_REGISTRY_MISSES_PER_S: '100000' }, 1000);
    await runGenerator(label, 'idle-tunnels.ts', ['--tunnels', String(tunnels), '--hold-s', '30']);
    await stopRelay(relay);
    const result = readJson(`${label}.json`) as IdleResult | null;
    if (result === null) throw new Error(`${label}: no result`);
    const samples = within(samplesOf(label), result.startedAt - 2000, (result.allReadyAt ?? result.holdStart) + 2000);
    const row = {
        tunnels,
        establishSeconds: result.establishSeconds,
        handshakesPerS: result.establishSeconds === null ? null : tunnels / result.establishSeconds,
        handshakeMs: result.report.handshakeMs,
        rejects: result.report.rejects,
        dialFailures: result.report.dialFailures,
        peakCpuPercent: peakCpuPercent(samples),
    };
    summaryJson['establishUnpaced'] = row;
    note();
    note(`# Establishing ${String(tunnels)} tunnels with RELAY_REGISTRY_MISSES_PER_S out of the way`);
    note();
    note(
        '| Established in (s) | Tunnels/s | Handshake p50/p95 (ms) | Peak CPU (% of a core) | Rejects | Dial failures |',
    );
    note('| --- | --- | --- | --- | --- | --- |');
    note(
        `| ${fixed(result.establishSeconds ?? Number.NaN)} | ${fixed(row.handshakesPerS ?? Number.NaN, 0)} | ${fixed(result.report.handshakeMs.p50, 0)}/${fixed(result.report.handshakeMs.p95, 0)} | ${fixed(row.peakCpuPercent, 0)} | ${JSON.stringify(row.rejects)} | ${JSON.stringify(row.dialFailures)} |`,
    );
}

async function stormScenario(): Promise<void> {
    const tunnels = num(args['storm-tunnels'], 1000);
    const label = `storm-${String(tunnels)}`;
    const relay = await startRelay(label, {}, 1000);
    const background = generator(label, 'idle-tunnels.ts', ['--tunnels', String(tunnels), '--hold-s', '0']);
    if (!(await waitConnected(label, 15 * 60_000))) throw new Error(`${label}: tunnels never all connected`);
    await sleep(STEADY_SKIP_MS);
    const restartAt = Date.now();
    await mustCompose(['restart', 'relay'], label);
    const recovered = await waitConnected(label, 15 * 60_000);
    await sleep(num(args['storm-hold-s'], 300) * 1000);
    await stopGenerator(label, background);
    await stopRelay(relay);
    const result = readJson(`${label}.json`) as IdleResult | null;
    if (result === null) throw new Error(`${label}: no result`);
    // Rebuild the connected count over time from the generator's own ready/lost events.
    const events = [
        ...result.report.readyTimes.map((at) => ({ at, delta: 1 })),
        ...result.report.lostTimes.map((at) => ({ at, delta: -1 })),
    ].sort((a, b) => a.at - b.at);
    let connected = 0;
    let firstBack: number | null = null;
    let allBack: number | null = null;
    let lowest = tunnels;
    for (const event of events) {
        connected += event.delta;
        if (event.at < restartAt) continue;
        lowest = Math.min(lowest, connected);
        if (event.delta > 0 && firstBack === null && lowest < tunnels) firstBack = event.at;
        if (allBack === null && lowest < tunnels && connected === tunnels) allBack = event.at;
    }
    const samples = samplesOf(label);
    const stormSamples = within(samples, restartAt, (allBack ?? restartAt) + 10_000);
    const row = {
        tunnels,
        recovered,
        firstBackSeconds: firstBack === null ? null : (firstBack - restartAt) / 1000,
        allBackSeconds: allBack === null ? null : (allBack - restartAt) / 1000,
        lowestConnected: lowest,
        peakCpuPercent: peakCpuPercent(stormSamples),
        rejects: result.report.rejects,
        dialFailures: result.report.dialFailures,
        lost: result.report.lost,
    };
    summaryJson['storm'] = row;
    note();
    note(`# Reconnect storm (${String(tunnels)} tunnels, relay restarted)`);
    note();
    note(
        '| First tunnel back (s) | All back (s) | Peak CPU (% of a core, 1 s samples) | Rejects while recovering | Dial failures |',
    );
    note('| --- | --- | --- | --- | --- |');
    note(
        `| ${fixed(row.firstBackSeconds ?? Number.NaN)} | ${fixed(row.allBackSeconds ?? Number.NaN)} | ${fixed(row.peakCpuPercent, 0)} | ${JSON.stringify(row.rejects)} | ${JSON.stringify(row.dialFailures)} |`,
    );
}

interface ScreencastResult {
    readonly cells: readonly CellResult[];
    readonly engineLoopDelayP99Ms: number;
    readonly browserLoopDelayP99Ms: number;
    readonly engineTunnelsLost: Record<string, number>;
}

async function screencastScenario(): Promise<void> {
    const background = num(args.background, 1000);
    const label = 'screencast';
    const relay = await startRelay(label);
    const backgroundLabel = `${label}-background`;
    let idle: Spawned | null = null;
    if (background > 0) {
        idle = generator(backgroundLabel, 'idle-tunnels.ts', ['--tunnels', String(background), '--hold-s', '0']);
        if (!(await waitConnected(backgroundLabel, 15 * 60_000))) throw new Error('background never connected');
    }
    // The background's own traffic (pings), subtracted from each cell's bytes.
    const quietFrom = Date.now();
    await sleep(STEADY_SKIP_MS);
    const quietTo = Date.now();
    await runGenerator(label, 'screencast.ts', [
        '--cell-s',
        String(num(args['cell-s'], 180)),
        '--warmup-s',
        String(num(args['warmup-s'], 30)),
        ...(args.cells === undefined ? [] : ['--cells', args.cells]),
    ]);
    if (idle !== null) await stopGenerator(backgroundLabel, idle);
    await stopRelay(relay);
    const result = readJson(`${label}.json`) as ScreencastResult | null;
    if (result === null) throw new Error('screencast: no result');
    const samples = samplesOf(label);
    const quiet = within(samples, quietFrom, quietTo);
    const quietTx = averageRate(quiet, 'net_tx_bytes');
    const quietRx = averageRate(quiet, 'net_rx_bytes');
    note(`# Screencast (${String(background)} idle tunnels in the background)`);
    note();
    note(
        '| Cell | Frame | fps | Streams | Achieved fps min/mean | Latency p50/p95/p99 (ms) | Relay CPU (% of a core) | Relay egress per stream (GB/h) | Relay in+out per stream (GB/h) | Dropped by engine | Open failures | Notes |',
    );
    note('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const rows: unknown[] = [];
    for (const cell of result.cells) {
        const window = within(samples, cell.measureStart, cell.measureEnd);
        const streams = cell.cell.kind === 'fairness' ? 1 + cell.cell.bulkStreams : cell.cell.streams;
        const tx = averageRate(window, 'net_tx_bytes') - quietTx;
        const rx = averageRate(window, 'net_rx_bytes') - quietRx;
        const castStreams = cell.cell.kind === 'fairness' ? 1 : cell.cell.streams;
        const egressGbPerHour = cell.cell.kind === 'fairness' ? Number.NaN : ((tx / castStreams) * 3600) / 1e9;
        const totalGbPerHour = cell.cell.kind === 'fairness' ? Number.NaN : (((tx + rx) / castStreams) * 3600) / 1e9;
        const dropped = cell.screencast.streams.reduce((sum, stream) => sum + stream.droppedByEngine, 0);
        const latency = cell.screencast.latencyMs;
        const row = {
            name: cell.name,
            cell: cell.cell,
            fpsMin: cell.screencast.fpsMin,
            fpsMean: cell.screencast.fpsMean,
            latencyMs: latency,
            cpuPercent: cpuPercent(window),
            egressGbPerHourPerStream: egressGbPerHour,
            totalGbPerHourPerStream: totalGbPerHour,
            payloadGbPerHourPerStream: cell.screencast.payloadBytesPerHourPerStream / 1e9,
            droppedByEngine: dropped,
            openFailures: cell.openFailures,
            closedEarly: cell.closedEarly,
            bulkMBps: cell.bulkBytesPerS === null ? null : cell.bulkBytesPerS / 1e6,
            relayRssMiB: medianOf(window, 'rss_bytes') / MIB,
            loopDelayP99MaxMs: maxOf(window, 'loop_delay_p99_ms'),
        };
        rows.push(row);
        const frame = cell.cell.kind === 'fairness' ? '100 KB' : `${String(cell.cell.frameBytes / 1024)} KB`;
        const fps = cell.cell.kind === 'fairness' ? '5' : String(cell.cell.fps);
        const notes =
            cell.cell.kind === 'fairness'
                ? `engine A: ${String(cell.cell.bulkStreams)} downloads at ${fixed(row.bulkMBps ?? Number.NaN, 2)} MB/s`
                : '';
        note(
            `| ${cell.name} | ${frame} | ${fps} | ${String(streams)} | ${fixed(row.fpsMin, 2)}/${fixed(row.fpsMean, 2)} | ${fixed(latency.p50)}/${fixed(latency.p95)}/${fixed(latency.p99)} | ${fixed(row.cpuPercent)} | ${fixed(egressGbPerHour, 3)} | ${fixed(totalGbPerHour, 3)} | ${String(dropped)} | ${String(cell.openFailures)} | ${notes} |`,
        );
    }
    note();
    note(
        `Generator: engine loop p99 ${fixed(result.engineLoopDelayP99Ms)} ms, browser loop p99 ${fixed(result.browserLoopDelayP99Ms)} ms; engine tunnels lost ${JSON.stringify(result.engineTunnelsLost)}; background tx ${fixed(quietTx / 1024)} KiB/s.`,
    );
    summaryJson['screencast'] = { background, quietTxBytesPerS: quietTx, quietRxBytesPerS: quietRx, rows };
}

interface SlowReaderStep {
    readonly at: number;
    readonly target: number;
    readonly open: number;
    readonly established: number;
    readonly refused: number;
}

interface SlowReadersResult {
    readonly result: { readonly steps: readonly SlowReaderStep[]; readonly engineTunnelsLost: Record<string, number> };
}

interface FloodResult {
    readonly result: {
        readonly holdStart: number;
        readonly holdEnd: number;
        readonly openedTotal: number;
        readonly evicted: number;
        readonly timeline: readonly { readonly at: number; readonly open: number }[];
        readonly canaryBrowser: {
            readonly ok: number;
            readonly failed: number;
            readonly ms: { readonly p50: number; readonly p95: number };
        };
        readonly canaryEngine: {
            readonly attempts: number;
            readonly readies: number;
            readonly handshakeMs: { readonly p50: number; readonly p95: number };
        };
    };
}

async function slowReaders(label: string, overrides: Record<string, string>, connections: number): Promise<void> {
    const relay = await startRelay(label, overrides);
    const startedAt = Date.now();
    await runGenerator(label, 'worst-case.ts', [
        '--mode',
        'slow-readers',
        '--connections',
        String(connections),
        '--step',
        String(num(args.step, 500)),
        '--plateau-s',
        String(num(args['plateau-s'], 45)),
        '--hold-s',
        '30',
    ]);
    await stopRelay(relay);
    const result = readJson(`${label}.json`) as SlowReadersResult | null;
    if (result === null) throw new Error(`${label}: no result (the relay may have been killed; see its log)`);
    const samples = samplesOf(label);
    const baseline = memoryOf(within(samples, relay.readyAt, startedAt));
    note();
    note(`## ${label} (${JSON.stringify(overrides)})`);
    note();
    note(
        '| Streams held | Refused so far | RSS (MiB) | Heap used (MiB) | External (MiB) | Kernel TCP queues (MiB) | RSS/stream (KiB) | Heap/stream (KiB) | External/stream (KiB) | TCP queues/stream (KiB) | CPU (% of a core) |',
    );
    note('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const rows: unknown[] = [];
    for (const step of result.result.steps) {
        // The last 20 s of each plateau, after the windows have filled.
        const window = within(samples, step.at - 20_000, step.at);
        const loaded = memoryOf(window);
        const per = perConnection(loaded, baseline, Math.max(1, step.established));
        rows.push({ step, loaded, perStream: per, cpuPercent: cpuPercent(window) });
        note(
            `| ${String(step.established)} | ${String(step.refused)} | ${mib(loaded.rss)} | ${mib(loaded.heapUsed)} | ${mib(loaded.external)} | ${mib(loaded.tcpQueued)} | ${kib(per.rss)} | ${kib(per.heapUsed)} | ${kib(per.external)} | ${kib(per.tcpQueued)} | ${fixed(cpuPercent(window))} |`,
        );
    }
    note(
        `Baseline: RSS ${mib(baseline.rss)} MiB, cgroup ${mib(baseline.cgroup)} MiB. Peak cgroup memory ${mib(maxOf(samples, 'cgroup_memory_bytes'))} MiB.`,
    );
    summaryJson[label] = { overrides, baseline, rows };
}

async function flood(label: string, kind: 'silent' | 'partial', connections: number): Promise<void> {
    const relay = await startRelay(label);
    const startedAt = Date.now();
    await runGenerator(label, 'worst-case.ts', [
        '--mode',
        'flood',
        '--kind',
        kind,
        '--connections',
        String(connections),
        '--rate',
        '2000',
        '--hold-s',
        String(num(args['hold-s'], 120)),
    ]);
    await stopRelay(relay);
    const result = readJson(`${label}.json`) as FloodResult | null;
    if (result === null) throw new Error(`${label}: no result`);
    const samples = samplesOf(label);
    const baseline = memoryOf(within(samples, relay.readyAt, startedAt));
    const window = within(samples, result.result.holdStart + 30_000, result.result.holdEnd);
    const loaded = memoryOf(window);
    const open = result.result.timeline.filter((point) => point.at >= result.result.holdStart + 30_000);
    const held = open.length === 0 ? 0 : open.reduce((sum, point) => sum + point.open, 0) / open.length;
    const per = perConnection(loaded, baseline, Math.max(1, held));
    const { canaryBrowser, canaryEngine } = result.result;
    summaryJson[label] = {
        kind,
        connections,
        held,
        baseline,
        loaded,
        perConnection: per,
        cpuPercent: cpuPercent(window),
        result: result.result,
    };
    note(
        `| ${kind} | ${String(connections)} | ${fixed(held, 0)} | ${String(result.result.evicted)} | ${mib(loaded.rss)} | ${mib(loaded.tcpQueued)} | ${kib(per.rss)} | ${kib(per.tcpQueued)} | ${fixed(cpuPercent(window))} | ${String(canaryBrowser.ok)}/${String(canaryBrowser.ok + canaryBrowser.failed)}, p95 ${fixed(canaryBrowser.ms.p95, 0)} ms | ${String(canaryEngine.readies)}/${String(canaryEngine.attempts)}, p95 ${fixed(canaryEngine.handshakeMs.p95, 0)} ms |`,
    );
}

async function worstCaseScenario(): Promise<void> {
    note('# Worst case: slow-reading browsers');
    await slowReaders('slow-readers-default', {}, num(args.connections, 4000));
    const raised = num(args['raised-connections'], 8000);
    if (raised > 0) {
        await slowReaders('slow-readers-raised', { RELAY_MEMORY_BUDGET_BYTES: String(4096 * MIB) }, raised);
    }
    const floodSize = num(args.flood, 10_000);
    if (floodSize > 0) {
        note();
        note('# Worst case: pre-ClientHello flood');
        note();
        note(
            '| Kind | Flood target | Held open (mean) | Closed by the relay | RSS (MiB) | Kernel TCP queues (MiB) | RSS/conn (KiB) | TCP queues/conn (KiB) | CPU (% of a core) | Canary browser ok, p95 | Canary engine ok, p95 |',
        );
        note('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
        await flood('flood-silent', 'silent', floodSize);
        await flood('flood-partial', 'partial', floodSize);
    }
}

async function main(): Promise<void> {
    const scenarios: Record<string, () => Promise<void>> = {
        idle: idleScenario,
        screencast: screencastScenario,
        'worst-case': worstCaseScenario,
    };
    const run = scenarios[scenario];
    if (run === undefined) throw new Error(`usage: run.ts ${Object.keys(scenarios).join('|')} [options]`);
    note(`<!-- ${new Date().toISOString()} ${scenario} -->`);
    if (!args['skip-build']) await mustCompose(['--profile', 'tools', 'build'], 'build');
    await mustCompose(['--profile', 'tools', 'run', '--rm', '-T', 'prepare'], 'prepare');
    try {
        await run();
    } finally {
        writeFileSync(join(runDir, 'summary.md'), `${summary.join('\n')}\n`);
        writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summaryJson, null, 2)}\n`);
        await compose(['--profile', 'tools', 'down', '--volumes', '--remove-orphans'], 'down').exited;
        process.stdout.write(`\nResults in ${runDir}\n`);
    }
}

await main();
