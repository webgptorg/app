/**
 * What one connection can cost the relay at worst, to size the global connection cap and the memory budget.
 *
 * `--mode slow-readers`: browsers that complete TLS with an engine, ask for a large response and never read it. The
 * engine writes only within credit, so each such stream pins its window in the relay plus whatever the kernel buffers.
 * Connections open in steps with a plateau after each, so memory per connection is the slope across steps.
 *
 * `--mode flood`: connections that never finish their ClientHello (`--kind silent` sends nothing, `partial` all but
 * the last byte of a ~29 KB ClientHello), held at `--connections` and reopened as the relay evicts them. A canary
 * browser and a canary engine keep checking that real traffic still gets through.
 */
import type { AddressInfo, Socket } from 'node:net';
import { connect as connectTcp, createServer } from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { connect as connectTls } from 'node:tls';

import { parseClientHello } from '@ptbk/protocol';

import type { BrowserTarget } from './lib/browser';
import { connectThroughRelay } from './lib/browser';
import { createEngineServer } from './lib/engine-server';
import { createEngineTunnel } from './lib/engine-tunnel';
import { createFleetStats } from './lib/fleet-stats';
import { startFleet } from './lib/fleet';
import { RELAY_HOST, RELAY_PORT, engineTrust, loadEngines, relayEndpoint } from './lib/fixtures';
import { log, parseOptions, sleep, writeResult } from './lib/output';
import { percentiles } from './lib/stats';

const options = parseOptions(
    {
        offset: 5100,
        engines: 16,
        connections: 4000,
        step: 500,
        'plateau-s': 45,
        'hold-s': 120,
        'response-bytes': 64 << 20,
        rate: 150,
    },
    { mode: 'slow-readers', kind: 'silent', label: 'worst-case' },
);

const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

interface Step {
    readonly at: number;
    readonly target: number;
    readonly open: number;
    readonly established: number;
    readonly refused: number;
}

async function paced(count: number, perSecond: number, open: (index: number) => void): Promise<void> {
    const started = performance.now();
    for (let index = 0; index < count; index++) {
        const due = started + (index * 1000) / perSecond;
        const wait = due - performance.now();
        if (wait > 1) await sleep(wait);
        open(index);
    }
}

async function slowReaders(): Promise<unknown> {
    const engines = await loadEngines(options.offset, options.engines);
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
    const trust = await engineTrust();
    const sockets = new Set<Socket>();
    let established = 0;
    let refused = 0;
    let opened = 0;
    const request = `GET /blob?bytes=${String(options['response-bytes'])} HTTP/1.1\r\nhost: engine\r\n\r\n`;
    const openOne = (): void => {
        const engine = engines[opened++ % engines.length];
        if (engine === undefined) return;
        const target: BrowserTarget = {
            relayHost: RELAY_HOST,
            relayPort: RELAY_PORT,
            hostname: engine.hostname,
            trust,
        };
        const socket = connectThroughRelay(target);
        sockets.add(socket);
        let secure = false;
        socket.once('secureConnect', () => {
            secure = true;
            established++;
            socket.write(request);
            // Never read again: the relay must hold what the engine sends, up to the stream's window.
            socket.pause();
        });
        socket.on('error', () => undefined);
        socket.once('close', () => {
            sockets.delete(socket);
            if (secure) established--;
            else refused++;
        });
    };
    const steps: Step[] = [];
    log('worst-case.slow-readers', { engines: engines.length, connections: options.connections });
    for (let target = options.step; target <= options.connections; target += options.step) {
        await paced(target - opened, options.rate, openOne);
        await sleep(options['plateau-s'] * 1000);
        const step = { at: Date.now(), target, open: sockets.size, established, refused };
        steps.push(step);
        log('worst-case.step', { ...step });
    }
    const holdStart = Date.now();
    await sleep(options['hold-s'] * 1000);
    const holdEnd = Date.now();
    for (const socket of sockets) socket.destroy();
    const report = fleet.stats.report(engines.length);
    fleet.stop();
    server.close();
    return { steps, holdStart, holdEnd, engineTunnelsLost: report.lost, streamsOpened: report.streamsOpened };
}

/** A real ClientHello as Node sends it, with an ALPN list that makes it about 29 KB, just under the relay's 32 KiB. */
async function largeClientHello(servername: string): Promise<Buffer> {
    const protocols = Array.from({ length: 115 }, (_, index) => `p${String(index).padStart(3, '0')}`.padEnd(250, 'x'));
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
        return await new Promise<Buffer>((resolve) => {
            const chunks: Buffer[] = [];
            server.once('connection', (socket: Socket) => {
                socket.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                    const bytes = Buffer.concat(chunks);
                    if (parseClientHello(bytes, { maxBytes: 65_536 }).kind !== 'need-more') {
                        socket.destroy();
                        resolve(bytes);
                    }
                });
            });
            connectTls({ host: '127.0.0.1', port, servername, ALPNProtocols: protocols }).on('error', () => undefined);
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function flood(): Promise<unknown> {
    const [browserEngine, canaryEngine] = await loadEngines(options.offset, 2);
    if (browserEngine === undefined || canaryEngine === undefined) throw new Error('two engines needed');
    const server = await createEngineServer();
    const fleet = await startFleet({
        engines: [browserEngine],
        rampMs: 0,
        label: options.label,
        onStream: (_engine, stream) => {
            server.handle(stream);
        },
    });
    await fleet.allReady();
    const trust = await engineTrust();
    const hello = options.kind === 'partial' ? (await largeClientHello(browserEngine.hostname)).subarray(0, -1) : null;
    const sockets = new Set<Socket>();
    let openedTotal = 0;
    let evicted = 0;
    let stopping = false;
    const openOne = (): void => {
        if (stopping) return;
        openedTotal++;
        const socket = connectTcp(RELAY_PORT, RELAY_HOST);
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.once('connect', () => {
            if (hello !== null) socket.write(hello);
        });
        socket.once('close', () => {
            sockets.delete(socket);
            if (!stopping) evicted++;
        });
    };
    // Keeps the flood at its size: whatever the relay closes is reopened, no faster than --rate.
    const refill = setInterval(() => {
        const missing = Math.min(options.connections - sockets.size, Math.ceil(options.rate / 10));
        for (let index = 0; index < missing; index++) openOne();
    }, 100);

    const browserMs: number[] = [];
    let browserFailures = 0;
    const canaryBrowser = setInterval(() => {
        const started = performance.now();
        const socket = connectThroughRelay({
            relayHost: RELAY_HOST,
            relayPort: RELAY_PORT,
            hostname: browserEngine.hostname,
            trust,
        });
        let received = 0;
        socket.on('error', () => undefined);
        socket.once('secureConnect', () => {
            socket.write('GET /blob?bytes=1024 HTTP/1.1\r\nhost: engine\r\nconnection: close\r\n\r\n');
        });
        socket.on('data', (chunk: Buffer) => {
            received += chunk.length;
        });
        socket.once('close', () => {
            if (received > 1024) browserMs.push(performance.now() - started);
            else browserFailures++;
        });
        socket.setTimeout(10_000, () => socket.destroy());
    }, 1000);

    // A tunnel dialled afresh every 10 s: engines must still get in while the pending budget is flooded.
    const canaryStats = createFleetStats();
    const relay = await relayEndpoint();
    let canaryTunnel = createEngineTunnel({ relay, signer: canaryEngine.signer, stats: canaryStats });
    canaryTunnel.start();
    const canaryEngineTimer = setInterval(() => {
        canaryTunnel.stop();
        canaryTunnel = createEngineTunnel({ relay, signer: canaryEngine.signer, stats: canaryStats });
        canaryTunnel.start();
    }, 10_000);

    const timeline: { at: number; open: number; evicted: number }[] = [];
    const sampler = setInterval(() => {
        timeline.push({ at: Date.now(), open: sockets.size, evicted });
    }, 5000);
    log('worst-case.flood', { kind: options.kind, connections: options.connections, helloBytes: hello?.length ?? 0 });
    const holdStart = Date.now();
    await sleep(options['hold-s'] * 1000);
    const holdEnd = Date.now();
    stopping = true;
    for (const timer of [refill, canaryBrowser, canaryEngineTimer, sampler]) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    canaryTunnel.stop();
    const canary = canaryStats.report(1);
    fleet.stop();
    server.close();
    return {
        kind: options.kind,
        helloBytes: hello?.length ?? 0,
        holdStart,
        holdEnd,
        openedTotal,
        evicted,
        timeline,
        canaryBrowser: { ok: browserMs.length, failed: browserFailures, ms: percentiles(browserMs) },
        canaryEngine: {
            attempts: canary.attempts,
            readies: canary.readies,
            rejects: canary.rejects,
            dialFailures: canary.dialFailures,
            handshakeMs: canary.handshakeMs,
        },
    };
}

const result = options.mode === 'flood' ? await flood() : await slowReaders();
writeResult(`${options.label}.json`, {
    scenario: 'worst-case',
    mode: options.mode,
    options,
    generatorLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
    result,
});
log('worst-case.done', { mode: options.mode });
await sleep(1000);
process.exit(0);
