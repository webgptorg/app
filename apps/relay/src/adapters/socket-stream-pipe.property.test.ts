import type { CloseCode, EngineId, TunnelCloseCode } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    EngineId as EngineIdSchema,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    MAX_WINDOW_BYTES,
    MAX_WINDOW_INCREMENT,
    StreamId,
    TUNNEL_CLOSE_CODE,
    encodeFrame,
} from '@ptbk/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { MemoryBudget } from '../domain/limits/memory-budget';
import { createMemoryBudget } from '../domain/limits/memory-budget';
import { TUNNEL_HIGH_WATER_BYTES, createStreamScheduler } from '../domain/routing/stream-scheduler';
import type { ClientAddress, TunnelSession } from '../domain/tunnel/tunnel-session';
import { createTunnelSession } from '../domain/tunnel/tunnel-session';
import type { FakeEventLoop, FakeSocket } from '../testing/fake-socket';
import { createFakeEventLoop, createFakeSocket } from '../testing/fake-socket';
import type { FakeTransport } from '../testing/fake-transport';
import { createFakeTransport } from '../testing/fake-transport';
import type { FakeClock } from './fake-clock';
import { createFakeClock } from './fake-clock';
import type { SocketStreamPipe } from './socket-stream-pipe';
import { READ_RESERVE_BYTES, STREAM_RESERVE_BYTES, pipeSocketToStream } from './socket-stream-pipe';

const ENGINE_ID: EngineId = EngineIdSchema.parse('m'.repeat(26));
const CLIENT: ClientAddress = { family: 4, address: Uint8Array.of(192, 0, 2, 1), port: 50_000 };
/** Low enough that a run of commands can spend it; every clock step below refills it completely. */
const FRAMES_PER_S = 16;
const MIN_WINDOW_INCREMENT_BYTES = 1024;
const STREAM_LIMITS = { firstByteTimeoutMs: 10_000, drainTimeoutMs: 30_000, endTimeoutMs: 30_000 };
const MAX_PIPES = 6;
/** Fewer reservations than pipes, so some runs go over budget and stop reading browsers. */
const MEMORY_BUDGET_BYTES = 4 * STREAM_RESERVE_BYTES;
const IGNORABLE_FRAME = Uint8Array.of(0x85, 0, 0, 0, 1, 9);
const INVALID_FRAMES = {
    open: encodeFrame({ type: FrameType.OPEN, streamId: StreamId.parse(1), ...CLIENT }),
    'empty-data': Uint8Array.of(FrameType.DATA, 0, 0, 0, 1),
    truncated: Uint8Array.of(FrameType.DATA, 0),
    'ignorable-known-type': Uint8Array.of(0x80 | FrameType.CLOSE, 0, 0, 0, 1, 0),
} as const;

/** One stream as the engine sees it: from the frames the relay sent and the ones the engine sent back. */
interface StreamView {
    open: boolean;
    /** DATA the engine may still send: the initial window plus the relay's WINDOW grants, minus DATA sent. */
    engineCredit: number;
    /** DATA the relay may still send: the initial window plus the engine's grants, minus DATA received. */
    relayCredit: number;
}

interface Model {
    readonly streams: Map<number, StreamView>;
    nextStreamId: number;
    framesLeft: number;
    pipes: number;
    closedWith: number | null;
    closedBySession: boolean;
    framesSeen: number;
}

interface PipeEntry {
    readonly fake: FakeSocket;
    pipe: SocketStreamPipe | null;
    streamEnded: boolean;
    done: boolean;
}

interface Real {
    readonly session: TunnelSession;
    readonly transport: FakeTransport;
    readonly clock: FakeClock;
    readonly loop: FakeEventLoop;
    readonly memory: MemoryBudget;
    readonly openPipe: (first: Uint8Array) => PipeEntry;
    readonly pipes: PipeEntry[];
    readonly failures: unknown[];
    readonly closedWith: number[];
}

function setup(): { model: Model; real: Real } {
    const transport = createFakeTransport();
    const clock = createFakeClock(1_700_000_000_000);
    const loop = createFakeEventLoop();
    const memory = createMemoryBudget(MEMORY_BUDGET_BYTES);
    const failures: unknown[] = [];
    const closedWith: number[] = [];
    const session = createTunnelSession({
        engineId: ENGINE_ID,
        remoteIp: '198.51.100.9',
        protocolVersion: 1,
        features: [],
        transport,
        onClosed: (code) => closedWith.push(code),
        clock,
        limits: { framesPerS: FRAMES_PER_S, minWindowIncrementBytes: MIN_WINDOW_INCREMENT_BYTES },
        terminations: { count: () => undefined },
    });
    const scheduler = createStreamScheduler({ tunnel: session, throttle: () => 0, clock });
    const pipes: PipeEntry[] = [];
    const openPipe = (first: Uint8Array): PipeEntry => {
        const entry: PipeEntry = { fake: createFakeSocket(loop), pipe: null, streamEnded: false, done: false };
        entry.pipe = pipeSocketToStream({
            socket: entry.fake.socket,
            first,
            open: (handlers) => session.openStream(CLIENT, handlers),
            scheduler,
            throttle: () => 0,
            countTraffic: () => undefined,
            clock,
            limits: STREAM_LIMITS,
            memory,
            countReset: () => undefined,
            onStreamEnd: () => {
                entry.streamEnded = true;
            },
            onDone: () => {
                entry.done = true;
            },
            onFailure: (error) => failures.push(error),
        });
        if (entry.pipe !== null) pipes.push(entry);
        return entry;
    };
    return {
        model: {
            streams: new Map(),
            nextStreamId: 1,
            framesLeft: FRAMES_PER_S,
            pipes: 0,
            closedWith: null,
            closedBySession: false,
            framesSeen: 0,
        },
        real: { session, transport, clock, loop, memory, openPipe, pipes, failures, closedWith },
    };
}

/** Reads what the relay sent since the last call, as the engine would, and checks it never breaks the protocol. */
function absorbRelayFrames(model: Model, real: Real): void {
    const frames = real.transport.frames;
    for (; model.framesSeen < frames.length; model.framesSeen++) {
        const frame = frames[model.framesSeen];
        if (frame === undefined) throw new Error('unreachable');
        if (frame.type === FrameType.OPEN) {
            expect(frame.streamId).toBe(model.nextStreamId);
            model.nextStreamId++;
            model.streams.set(frame.streamId, {
                open: true,
                engineCredit: INITIAL_WINDOW_BYTES,
                relayCredit: INITIAL_WINDOW_BYTES,
            });
            continue;
        }
        const view = model.streams.get(frame.streamId);
        if (view?.open !== true) {
            throw new Error(
                `relay sent frame type ${String(frame.type)} on stream ${String(frame.streamId)}, not open`,
            );
        }
        switch (frame.type) {
            case FrameType.DATA:
                expect(frame.payload.length).toBeGreaterThan(0);
                expect(frame.payload.length).toBeLessThanOrEqual(MAX_FRAME_PAYLOAD_BYTES);
                view.relayCredit -= frame.payload.length;
                expect(view.relayCredit, 'relay sent DATA beyond the credit the engine granted').toBeGreaterThanOrEqual(
                    0,
                );
                break;
            case FrameType.WINDOW:
                view.engineCredit += frame.increment;
                // The relay returns only what it delivered, so the engine's credit never exceeds one window.
                expect(view.engineCredit).toBeLessThanOrEqual(INITIAL_WINDOW_BYTES);
                break;
            case FrameType.CLOSE:
                view.open = false;
                break;
        }
    }
}

function closeModel(model: Model, code: number, bySession: boolean): void {
    model.closedWith = code;
    model.closedBySession = bySession;
    for (const view of model.streams.values()) view.open = false;
}

function checkInvariants(model: Model, real: Real): void {
    expect(real.failures).toEqual([]);
    expect(real.session.isClosed()).toBe(model.closedWith !== null);
    expect(real.closedWith).toEqual(model.closedWith === null ? [] : [model.closedWith]);
    expect(real.transport.closes.map((close) => close.code)).toEqual(
        model.closedBySession && model.closedWith !== null ? [model.closedWith] : [],
    );
    const openStreams = [...model.streams.values()].filter((view) => view.open).length;
    expect(real.session.activeStreams()).toBe(openStreams);

    const live = real.pipes.filter((entry) => !entry.done);
    // Each stream holds at most its window towards the browser and one read towards the engine.
    for (const entry of live) {
        expect(entry.fake.socket.writableLength).toBeLessThanOrEqual(INITIAL_WINDOW_BYTES);
        expect(entry.pipe?.bufferedBytes()).toBeLessThanOrEqual(STREAM_RESERVE_BYTES);
    }
    // A browser that goes away without a FIN takes its stream with it, and so does a tunnel that closes.
    for (const entry of real.pipes) {
        if (entry.fake.isClosed() && !entry.fake.sawFin()) expect(entry.streamEnded).toBe(true);
    }
    if (model.closedWith !== null) expect(real.pipes.every((entry) => entry.streamEnded)).toBe(true);
    expect(real.memory.used()).toBeGreaterThanOrEqual(0);
    expect(real.memory.used()).toBeLessThanOrEqual(live.length * STREAM_RESERVE_BYTES);
}

function settle(model: Model, real: Real): void {
    real.loop.runUntilIdle();
    absorbRelayFrames(model, real);
    checkInvariants(model, real);
}

/** A stream the engine names: an open one, any it has seen (closed ones too), or one the relay never opened. */
type Target =
    { readonly kind: 'open' | 'seen'; readonly pick: number } | { readonly kind: 'unknown'; readonly ahead: number };

const canTarget = (model: Readonly<Model>, target: Target): boolean =>
    target.kind === 'unknown' || model.streams.size > 0;

function resolveTarget(model: Model, target: Target): number {
    if (target.kind === 'unknown') return model.nextStreamId + target.ahead;
    const seen = [...model.streams.keys()];
    const open = seen.filter((id) => model.streams.get(id)?.open === true);
    const ids = target.kind === 'open' && open.length > 0 ? open : seen;
    return ids[target.pick % ids.length] as number;
}

/**
 * Sends one engine frame after predicting its effect: `judge` returns the close code the frame must cause, or
 * `undefined` if the session accepts or ignores it, and updates the engine's view of the stream it names.
 */
function engineSends(model: Model, real: Real, frame: Uint8Array, judge: () => TunnelCloseCode | undefined): void {
    absorbRelayFrames(model, real);
    let expected: TunnelCloseCode | undefined;
    if (model.closedWith === null) {
        if (model.framesLeft === 0) {
            expected = TUNNEL_CLOSE_CODE.FRAME_BUDGET;
        } else {
            model.framesLeft--;
            expected = judge();
        }
    }
    real.session.receive(frame);
    // What the relay sent while handling the frame (a CLOSE after a flow-control violation) precedes the close.
    absorbRelayFrames(model, real);
    if (expected !== undefined) closeModel(model, expected, true);
    settle(model, real);
}

function onStream(
    model: Model,
    id: number,
    whenOpen: (view: StreamView) => TunnelCloseCode | undefined,
): TunnelCloseCode | undefined {
    if (id >= model.nextStreamId) return TUNNEL_CLOSE_CODE.PROTOCOL_ERROR;
    const view = model.streams.get(id);
    // A frame for a stream that already closed crossed the CLOSE on the wire: dropped.
    if (view === undefined || !view.open) return undefined;
    return whenOpen(view);
}

type Command = fc.Command<Model, Real>;

function command(
    label: string,
    run: (model: Model, real: Real) => void,
    check: (model: Readonly<Model>) => boolean = () => true,
): Command {
    return { check, run, toString: () => label };
}

type DataSize = number | 'fill' | 'over';

function engineData(target: Target, size: DataSize): Command {
    return command(
        `EngineData(${JSON.stringify(target)}, ${String(size)})`,
        (model, real) => {
            absorbRelayFrames(model, real);
            const id = resolveTarget(model, target);
            const credit = model.streams.get(id)?.engineCredit ?? 0;
            let length: number;
            if (size === 'fill') length = credit;
            else if (size === 'over') length = credit + 1;
            else length = size;
            length = Math.min(Math.max(length, 1), MAX_FRAME_PAYLOAD_BYTES);
            const frame = encodeFrame({
                type: FrameType.DATA,
                streamId: StreamId.parse(id),
                payload: new Uint8Array(length).fill(0x42),
            });
            engineSends(model, real, frame, () =>
                onStream(model, id, (view) => {
                    if (length > view.engineCredit) return TUNNEL_CLOSE_CODE.PROTOCOL_ERROR;
                    view.engineCredit -= length;
                    return undefined;
                }),
            );
        },
        (model) => canTarget(model, target),
    );
}

type Increment = number | 'over';

function engineWindow(target: Target, by: Increment): Command {
    return command(
        `EngineWindow(${JSON.stringify(target)}, ${String(by)})`,
        (model, real) => {
            absorbRelayFrames(model, real);
            const id = resolveTarget(model, target);
            const credit = model.streams.get(id)?.relayCredit ?? 0;
            // One frame can overflow the window only while it holds credit; otherwise this is the largest valid grant.
            const increment = by === 'over' ? Math.min(MAX_WINDOW_BYTES - credit + 1, MAX_WINDOW_INCREMENT) : by;
            const frame = encodeFrame({ type: FrameType.WINDOW, streamId: StreamId.parse(id), increment });
            engineSends(model, real, frame, () =>
                onStream(model, id, (view) => {
                    if (increment > MAX_WINDOW_BYTES - view.relayCredit) return TUNNEL_CLOSE_CODE.PROTOCOL_ERROR;
                    view.relayCredit += increment;
                    return undefined;
                }),
            );
        },
        (model) => canTarget(model, target),
    );
}

function engineClose(target: Target, code: CloseCode): Command {
    return command(
        `EngineClose(${JSON.stringify(target)}, ${String(code)})`,
        (model, real) => {
            absorbRelayFrames(model, real);
            const id = resolveTarget(model, target);
            const frame = encodeFrame({ type: FrameType.CLOSE, streamId: StreamId.parse(id), code });
            engineSends(model, real, frame, () =>
                onStream(model, id, (view) => {
                    view.open = false;
                    return undefined;
                }),
            );
        },
        (model) => canTarget(model, target),
    );
}

const engineIgnorable = (): Command =>
    command('EngineIgnorable', (model, real) => {
        engineSends(model, real, IGNORABLE_FRAME, () => undefined);
    });

const engineInvalid = (kind: keyof typeof INVALID_FRAMES): Command =>
    command(`EngineInvalid(${kind})`, (model, real) => {
        engineSends(model, real, INVALID_FRAMES[kind], () => TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
    });

const browserConnects = (firstBytes: number): Command =>
    command(
        `BrowserConnects(${String(firstBytes)})`,
        (model, real) => {
            const entry = real.openPipe(new Uint8Array(firstBytes).fill(0x16));
            expect(entry.pipe === null).toBe(model.closedWith !== null);
            if (entry.pipe !== null) model.pipes++;
            settle(model, real);
        },
        (model) => model.pipes < MAX_PIPES,
    );

/** A command on one browser connection: `pick` chooses it among those opened so far. */
const browser = (label: string, pick: number, act: (browser: FakeSocket['browser']) => void): Command =>
    command(
        `${label}(${String(pick)})`,
        (model, real) => {
            const entry = real.pipes[pick % real.pipes.length];
            if (entry === undefined) throw new Error('unreachable');
            act(entry.fake.browser);
            settle(model, real);
        },
        (model) => model.pipes > 0,
    );

const timePasses = (ms: number): Command =>
    command(`TimePasses(${String(ms)})`, (model, real) => {
        // Every step is at least a second, which refills the whole frame budget.
        model.framesLeft = FRAMES_PER_S;
        real.clock.advance(ms);
        settle(model, real);
    });

const tunnelBackedUp = (bytes: number): Command =>
    command(`TunnelBackedUp(${String(bytes)})`, (model, real) => {
        real.transport.setBufferedBytes(bytes);
        settle(model, real);
    });

const tunnelDrops = (): Command =>
    command(
        'TunnelDrops',
        (model, real) => {
            absorbRelayFrames(model, real);
            real.session.transportClosed(1006);
            closeModel(model, 1006, false);
            settle(model, real);
        },
        (model) => model.closedWith === null,
    );

const target: fc.Arbitrary<Target> = fc.oneof(
    { weight: 36, arbitrary: fc.record({ kind: fc.constant('open' as const), pick: fc.nat() }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('seen' as const), pick: fc.nat() }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('unknown' as const), ahead: fc.nat({ max: 2 }) }) },
);
const dataSize: fc.Arbitrary<DataSize> = fc.oneof(
    { weight: 5, arbitrary: fc.integer({ min: 1, max: 4096 }) },
    { weight: 5, arbitrary: fc.integer({ min: 1, max: MAX_FRAME_PAYLOAD_BYTES }) },
    { weight: 2, arbitrary: fc.constant('fill' as const) },
    { weight: 1, arbitrary: fc.constant('over' as const) },
);
const increment: fc.Arbitrary<Increment> = fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 1, max: 2 * MIN_WINDOW_INCREMENT_BYTES }) },
    { weight: 6, arbitrary: fc.integer({ min: 1, max: INITIAL_WINDOW_BYTES }) },
    { weight: 1, arbitrary: fc.constant('over' as const) },
);
const pick = fc.nat();

/** `fc.commands` picks its arbitraries uniformly; repeating one weighs it, so violations stay rare enough for long runs. */
const weighted = <T>(weight: number, arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T>[] =>
    Array.from({ length: weight }, () => arbitrary);

const commands = fc.commands(
    [
        ...weighted(
            12,
            fc.tuple(target, dataSize).map(([to, size]) => engineData(to, size)),
        ),
        ...weighted(
            8,
            fc.tuple(target, increment).map(([to, by]) => engineWindow(to, by)),
        ),
        ...weighted(
            2,
            fc.tuple(target, fc.constantFrom(...Object.values(CLOSE_CODE))).map(([to, code]) => engineClose(to, code)),
        ),
        ...weighted(2, fc.constant(null).map(engineIgnorable)),
        fc.constantFrom(...(Object.keys(INVALID_FRAMES) as (keyof typeof INVALID_FRAMES)[])).map(engineInvalid),
        ...weighted(6, fc.integer({ min: 1, max: 2048 }).map(browserConnects)),
        ...weighted(
            8,
            fc.tuple(pick, fc.integer({ min: 1, max: READ_RESERVE_BYTES })).map(([at, bytes]) =>
                browser(`BrowserSends[${String(bytes)}]`, at, (peer) => {
                    peer.send(new Uint8Array(bytes).fill(0x17));
                }),
            ),
        ),
        ...weighted(
            10,
            fc.tuple(pick, fc.integer({ min: 1, max: 2 * MAX_FRAME_PAYLOAD_BYTES })).map(([at, bytes]) =>
                browser(`BrowserReads[${String(bytes)}]`, at, (peer) => {
                    peer.read(bytes);
                }),
            ),
        ),
        ...weighted(
            2,
            pick.map((at) =>
                browser('BrowserFin', at, (peer) => {
                    peer.fin();
                }),
            ),
        ),
        ...weighted(
            2,
            pick.map((at) =>
                browser('BrowserVanishes', at, (peer) => {
                    peer.vanish();
                }),
            ),
        ),
        ...weighted(4, fc.constantFrom(1000, 5000, 10_000, 30_000).map(timePasses)),
        ...weighted(2, fc.constantFrom(0, TUNNEL_HIGH_WATER_BYTES).map(tunnelBackedUp)),
        fc.constant(null).map(tunnelDrops),
    ],
    { maxCommands: 120, size: 'max' },
);

/**
 * The session, the scheduler and the pipes are real; the browsers are fake sockets on a fake event loop and the engine
 * is the command sequence. The model is the engine's view of each stream, built from the frames the relay sent, so it
 * predicts which engine frames the session must accept, drop or close the tunnel for.
 */
describe('tunnel session and socket pipe against a hostile engine (model-based)', () => {
    it('never throw, keep buffers within the windows, and close the session on every violation', () => {
        fc.assert(
            fc.property(commands, (sequence) => {
                const { model, real } = setup();
                fc.modelRun(() => ({ model, real }), sequence);

                // Whatever happened, the browsers and the tunnel going away release everything, timers included.
                for (const entry of real.pipes) entry.fake.browser.vanish();
                real.loop.runUntilIdle();
                real.session.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
                real.loop.runUntilIdle();
                expect(real.failures).toEqual([]);
                expect(real.pipes.every((entry) => entry.done)).toBe(true);
                expect(real.memory.used()).toBe(0);
                expect(real.clock.pendingTimers()).toBe(0);
            }),
            // A fixed seed: every run explores the same sequences, so CI is reproducible and a failure replays.
            { seed: 0x6e06, numRuns: 200 },
        );
    });
});
