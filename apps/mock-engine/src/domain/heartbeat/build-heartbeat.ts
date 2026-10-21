import type { Bytes, EngineId, EngineVersion, Signer, Timestamp, UpdateState } from '@ptbk/protocol';
import { Timestamp as TimestampSchema, buildHeartbeat, signHeartbeat } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { SystemStatsSample } from './system-stats';

export interface HeartbeatFacts {
    readonly engineId: EngineId;
    readonly seq: number;
    readonly version: EngineVersion;
    /** When the engine started, from the same `Clock`. */
    readonly startedAtMs: number;
    readonly system: SystemStatsSample;
    readonly counts: { readonly agents: number; readonly members: number };
    readonly update: UpdateState;
}

export interface SignedHeartbeat {
    /** The exact bytes to send; the signature covers them, so they are never serialised again. */
    readonly rawBody: Bytes;
    /** The same bytes as text, for the security panel. */
    readonly body: string;
    /** The `Ptbk-Signature` value, `ed25519=<base64url>`. */
    readonly signature: string;
    readonly ts: Timestamp;
}

/** RFC 3339 UTC to the second, as the heartbeat's `ts` and the security panel's `sentAt`. */
export function isoSeconds(ms: number): Timestamp {
    return TimestampSchema.parse(new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
}

const decoder = new TextDecoder();

/**
 * C-03's `buildHeartbeat` checks the payload against the strict schema, rounds the percentages and serialises once;
 * C-03's `signHeartbeat` signs those bytes (`ptbk-heartbeat-v1` over their raw SHA-256). Nothing here adds a field.
 */
export async function buildSignedHeartbeat(
    facts: HeartbeatFacts,
    deps: { readonly clock: Clock; readonly signer: Signer; readonly signal?: AbortSignal },
): Promise<SignedHeartbeat> {
    const nowMs = deps.clock.nowMs();
    const ts = isoSeconds(nowMs);
    const rawBody = buildHeartbeat({
        engineId: facts.engineId,
        seq: facts.seq,
        ts,
        version: facts.version,
        uptimeS: Math.max(0, Math.floor((nowMs - facts.startedAtMs) / 1000)),
        diskPct: facts.system.diskPct,
        ramPct: facts.system.ramPct,
        cpuLoad: facts.system.cpuLoad,
        update: facts.update,
        agents: facts.counts.agents,
        members: facts.counts.members,
    });
    const signature = await signHeartbeat(deps.signer, rawBody, deps.signal);
    return Object.freeze({ rawBody, body: decoder.decode(rawBody), signature, ts });
}
