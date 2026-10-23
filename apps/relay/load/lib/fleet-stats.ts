import { percentiles } from './stats';
import type { Percentiles } from './stats';

/** Wall-clock milliseconds with sub-millisecond precision, comparable across the generator's processes. */
export function wallMs(): number {
    return performance.timeOrigin + performance.now();
}

export interface FleetSnapshot {
    readonly at: number;
    readonly engines: number;
    readonly connected: number;
    readonly attempts: number;
    readonly readies: number;
    readonly reconnects: number;
    /** Ready tunnels that closed, by WebSocket close code. */
    readonly lost: Readonly<Record<string, number>>;
    readonly rejects: Readonly<Record<string, number>>;
    readonly dialFailures: Readonly<Record<string, number>>;
    readonly protocolErrors: Readonly<Record<string, number>>;
    readonly streamsOpened: number;
}

export interface FleetReport extends FleetSnapshot {
    /** From dial to `ready`, milliseconds. */
    readonly handshakeMs: Percentiles;
    /** Wall-clock times of every `ready` and every loss of a ready tunnel. */
    readonly readyTimes: readonly number[];
    readonly lostTimes: readonly number[];
}

export interface FleetStats {
    attempt(): void;
    ready(handshakeMs: number): void;
    rejected(reason: string): void;
    dialFailed(kind: string): void;
    protocolError(reason: string): void;
    lost(code: number): void;
    reconnectScheduled(): void;
    streamOpened(): void;
    snapshot(engines: number): FleetSnapshot;
    report(engines: number): FleetReport;
}

function bump(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

export function createFleetStats(): FleetStats {
    let attempts = 0;
    let connected = 0;
    let reconnects = 0;
    let streamsOpened = 0;
    const lost: Record<string, number> = {};
    const rejects: Record<string, number> = {};
    const dialFailures: Record<string, number> = {};
    const protocolErrors: Record<string, number> = {};
    const handshakeMs: number[] = [];
    const readyTimes: number[] = [];
    const lostTimes: number[] = [];

    function snapshot(engines: number): FleetSnapshot {
        return {
            at: wallMs(),
            engines,
            connected,
            attempts,
            readies: readyTimes.length,
            reconnects,
            lost: { ...lost },
            rejects: { ...rejects },
            dialFailures: { ...dialFailures },
            protocolErrors: { ...protocolErrors },
            streamsOpened,
        };
    }

    return {
        attempt() {
            attempts++;
        },
        ready(ms) {
            connected++;
            handshakeMs.push(ms);
            readyTimes.push(Math.round(wallMs()));
        },
        rejected(reason) {
            bump(rejects, reason);
        },
        dialFailed(kind) {
            bump(dialFailures, kind);
        },
        protocolError(reason) {
            bump(protocolErrors, reason);
        },
        lost(code) {
            connected--;
            bump(lost, String(code));
            lostTimes.push(Math.round(wallMs()));
        },
        reconnectScheduled() {
            reconnects++;
        },
        streamOpened() {
            streamsOpened++;
        },
        snapshot,
        report(engines) {
            return { ...snapshot(engines), handshakeMs: percentiles(handshakeMs), readyTimes, lostTimes };
        },
    };
}
