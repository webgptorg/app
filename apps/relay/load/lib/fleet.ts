import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { OpenFrame } from '@ptbk/protocol';

import type { TunnelDuplex } from './engine-mux';
import type { EngineTunnel } from './engine-tunnel';
import { createEngineTunnel } from './engine-tunnel';
import type { FleetStats } from './fleet-stats';
import { createFleetStats } from './fleet-stats';
import type { LoadEngine } from './fixtures';
import { relayEndpoint } from './fixtures';
import { writeResult } from './output';

export interface Fleet {
    readonly stats: FleetStats;
    readonly tunnels: readonly EngineTunnel[];
    /** Resolves once every tunnel is ready at the same time, with the wall-clock time. */
    allReady(): Promise<number>;
    stop(): void;
}

export interface FleetOptions {
    readonly engines: readonly LoadEngine[];
    /** Spreads the first dials over this long; 0 dials every engine at once, as after a relay restart. */
    readonly rampMs: number;
    /** `<label>.status.json` is rewritten every second for the orchestrator. */
    readonly label: string;
    readonly onStream?: (engine: LoadEngine, stream: TunnelDuplex, open: OpenFrame) => void;
}

export async function startFleet(options: FleetOptions): Promise<Fleet> {
    const relay = await relayEndpoint();
    const stats = createFleetStats();
    const { engines } = options;
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const tunnels = engines.map((engine) =>
        createEngineTunnel({
            relay,
            signer: engine.signer,
            stats,
            ...(options.onStream === undefined
                ? {}
                : {
                      onStream: (stream: TunnelDuplex, open: OpenFrame) => {
                          options.onStream?.(engine, stream, open);
                      },
                  }),
        }),
    );
    tunnels.forEach((tunnel, index) => {
        const delay = options.rampMs === 0 ? 0 : (options.rampMs * index) / tunnels.length;
        setTimeout(() => {
            tunnel.start();
        }, delay);
    });
    const status = setInterval(() => {
        writeResult(`${options.label}.status.json`, {
            ...stats.snapshot(engines.length),
            generatorLoopDelayP99Ms: loopDelay.percentile(99) / 1e6,
        });
    }, 1000);
    return {
        stats,
        tunnels,
        allReady() {
            return new Promise((resolve) => {
                const check = setInterval(() => {
                    if (stats.snapshot(engines.length).connected < engines.length) return;
                    clearInterval(check);
                    resolve(Date.now());
                }, 50);
            });
        },
        stop() {
            clearInterval(status);
            loopDelay.disable();
            for (const tunnel of tunnels) tunnel.stop();
        },
    };
}
