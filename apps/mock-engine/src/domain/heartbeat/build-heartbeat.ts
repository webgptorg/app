import type {
    Bytes,
    EngineId,
    EngineVersion,
    HeartbeatAck,
    OwnerHandoff,
    SetupState,
    Signer,
    Timestamp,
    UpdateState,
} from '@ptbk/protocol';
import { Timestamp as TimestampSchema, buildHeartbeat, buildHeartbeatV2, signHeartbeat } from '@ptbk/protocol';

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
    /** Left out of the body when `null`: the engine has no browser setup. */
    readonly setup: SetupState | null;
    /** Left out of the body when `null`: no live handoff slot, or the address does not serve browsers yet. */
    readonly ownerHandoff?: OwnerHandoff | null;
    /** Present once the engine pinned a member key: it then sends heartbeat v2 (ADR 0018). */
    readonly teams?: { readonly accessRequests: number; readonly acks: readonly HeartbeatAck[] };
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
 * C-03's `buildHeartbeat` (or C-13's `buildHeartbeatV2`) checks the payload against the strict schema, rounds the
 * percentages and serialises once; `signHeartbeat` signs those bytes (`ptbk-heartbeat-v1` over their raw SHA-256).
 */
export async function buildSignedHeartbeat(
    facts: HeartbeatFacts,
    deps: { readonly clock: Clock; readonly signer: Signer; readonly signal?: AbortSignal },
): Promise<SignedHeartbeat> {
    const nowMs = deps.clock.nowMs();
    const ts = isoSeconds(nowMs);
    const fields = {
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
        ...(facts.setup === null ? {} : { setup: facts.setup }),
        ...(facts.ownerHandoff == null ? {} : { ownerHandoff: facts.ownerHandoff }),
    };
    const rawBody =
        facts.teams === undefined ? buildHeartbeat(fields) : buildHeartbeatV2({ ...fields, ...facts.teams });
    const signature = await signHeartbeat(deps.signer, rawBody, deps.signal);
    return Object.freeze({ rawBody, body: decoder.decode(rawBody), signature, ts });
}
