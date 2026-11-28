import {
    buildHeartbeat,
    buildHeartbeatV2,
    type HeartbeatAck,
    type HeartbeatAttention,
    EngineVersion,
    HEARTBEAT_SIGNATURE_HEADER,
    signHeartbeat,
    Timestamp,
    utf8Encode,
    type Bytes,
    type HeartbeatInput,
} from '@ptbk/protocol';

import type { TestEngine } from './test-engine';

export interface SignedHeartbeat {
    readonly body: Bytes;
    /** The `Ptbk-Signature` value. */
    readonly signature: string;
    readonly headers: Readonly<Record<string, string>>;
}

export function heartbeatInput(engine: TestEngine, seq: number, atMs: number): HeartbeatInput {
    return {
        engineId: engine.engineId,
        seq,
        ts: Timestamp.parse(new Date(atMs).toISOString()),
        version: EngineVersion.parse('1.4.2'),
        uptimeS: 3600,
        diskPct: 42,
        ramPct: 67,
        cpuLoad: 'low',
        update: 'none',
        agents: 3,
        members: 2,
    };
}

async function signed(engine: TestEngine, body: Bytes, signer = engine.signer): Promise<SignedHeartbeat> {
    const signature = await signHeartbeat(signer, body);
    return { body, signature, headers: { [HEARTBEAT_SIGNATURE_HEADER]: signature } };
}

/** The JSON object `buildHeartbeat` sends, to change before signing it with {@link signedJson}. */
export function heartbeatJson(engine: TestEngine, seq: number, atMs: number): Readonly<Record<string, unknown>> {
    return JSON.parse(new TextDecoder().decode(buildHeartbeat(heartbeatInput(engine, seq, atMs)))) as Record<
        string,
        unknown
    >;
}

/** A heartbeat as M-06 sends it: `buildHeartbeat`'s exact bytes, signed by the engine's key. */
export function signedHeartbeat(
    engine: TestEngine,
    seq: number,
    atMs: number,
    overrides: Partial<HeartbeatInput> = {},
): Promise<SignedHeartbeat> {
    return signed(engine, buildHeartbeat({ ...heartbeatInput(engine, seq, atMs), ...overrides }));
}

/** Any JSON, signed by `engine` (or `signer`), for bodies `buildHeartbeat` would refuse to produce. */
export function signedJson(
    engine: TestEngine,
    value: unknown,
    signer: TestEngine['signer'] = engine.signer,
): Promise<SignedHeartbeat> {
    return signed(engine, utf8Encode(JSON.stringify(value)), signer);
}

/** A v2 heartbeat (ADR 0018), with pending access requests and acks. */
export function signedHeartbeatV2(
    engine: TestEngine,
    seq: number,
    atMs: number,
    teams: {
        readonly accessRequests?: number;
        readonly acks?: readonly HeartbeatAck[];
        /** ADR 0027's unseen counts; left out, the owner has sharing switched off. */
        readonly attention?: readonly HeartbeatAttention[];
    } = {},
): Promise<SignedHeartbeat> {
    return signed(
        engine,
        buildHeartbeatV2({
            ...heartbeatInput(engine, seq, atMs),
            accessRequests: teams.accessRequests ?? 0,
            acks: teams.acks ?? [],
            ...(teams.attention === undefined ? {} : { attention: teams.attention }),
        }),
    );
}
