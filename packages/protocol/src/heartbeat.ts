import { z } from 'zod';

import type { Bytes } from './bytes';
import { utf8Encode } from './bytes';
import type { Signer } from './ed25519';
import { verifyEd25519 } from './ed25519';
import {
    Ed25519Signature,
    EngineId,
    EngineVersion,
    Timestamp,
    ed25519SignatureFromBytes,
    ed25519SignatureToBytes,
} from './ids';
import { SIGNING_CONTEXT, signingInput } from './signing-input';

export const HEARTBEAT_SIGNATURE_HEADER = 'Ptbk-Signature';
export const HEARTBEAT_MAX_BODY_BYTES = 4096;
export const HEARTBEAT_MAX_SKEW_MS = 120_000;
export const MAX_HEARTBEAT_COUNT = 1_000_000;

const SIGNATURE_HEADER_PREFIX = 'ed25519=';

const Percent = z.int().min(0).max(100).multipleOf(10);
const Count = z.int().min(0).max(MAX_HEARTBEAT_COUNT);

export const CpuLoad = z.enum(['low', 'medium', 'high']);
export type CpuLoad = z.infer<typeof CpuLoad>;

export const UpdateState = z.enum(['none', 'available', 'pending', 'installing']);
export type UpdateState = z.infer<typeof UpdateState>;

/**
 * The public promise of what the dashboard learns about an engine: numbers and closed enums only, no names or free
 * text. `seq` only has to increase strictly; engines send `max(lastSeq + 1, Date.now())` so one that loses its state
 * but keeps its key is not locked out.
 */
export const Heartbeat = z.strictObject({
    v: z.literal(1),
    engineId: EngineId,
    seq: z.int().min(0),
    ts: Timestamp,
    version: EngineVersion,
    uptimeS: z.int().min(0),
    diskPct: Percent,
    ramPct: Percent,
    cpuLoad: CpuLoad,
    update: UpdateState,
    agents: Count,
    members: Count,
});
export type Heartbeat = z.infer<typeof Heartbeat>;

export interface HeartbeatInput extends Omit<Heartbeat, 'v' | 'diskPct' | 'ramPct'> {
    /** Any value from 0 to 100; rounded to the nearest ten, halves up. */
    readonly diskPct: number;
    readonly ramPct: number;
}

export function heartbeatPath(engineId: EngineId): string {
    return `/v1/engines/${engineId}/heartbeat`;
}

function roundPercent(value: number): number {
    if (!(value >= 0 && value <= 100)) throw new RangeError('percentage must be between 0 and 100');
    return Math.round(value / 10) * 10;
}

/**
 * The exact bytes to send and sign. Throws on input outside the schema, which is a bug in the engine, never something
 * to send.
 */
export function buildHeartbeat(input: HeartbeatInput): Bytes {
    const heartbeat: Heartbeat = Heartbeat.parse({
        v: 1,
        engineId: input.engineId,
        seq: input.seq,
        ts: input.ts,
        version: input.version,
        uptimeS: input.uptimeS,
        diskPct: roundPercent(input.diskPct),
        ramPct: roundPercent(input.ramPct),
        cpuLoad: input.cpuLoad,
        update: input.update,
        agents: input.agents,
        members: input.members,
    });
    return utf8Encode(JSON.stringify(heartbeat));
}

async function heartbeatInput(body: Bytes): Promise<Bytes> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
    return signingInput(SIGNING_CONTEXT.heartbeat, digest);
}

/** Returns the `Ptbk-Signature` value, `ed25519=<base64url>`, over `signingInput('ptbk-heartbeat-v1', sha256(body))`. */
export async function signHeartbeat(signer: Signer, body: Bytes, signal?: AbortSignal): Promise<string> {
    const signature = await signer.sign(await heartbeatInput(body), signal);
    return `${SIGNATURE_HEADER_PREFIX}${ed25519SignatureFromBytes(signature)}`;
}

export type SignatureHeaderParse =
    { readonly kind: 'ok'; readonly signature: Ed25519Signature } | { readonly kind: 'invalid' };

/** Exactly `ed25519=<canonical base64url of 64 bytes>`; a missing header (`null`) is invalid too. */
export function parseSignatureHeader(value: string | null | undefined): SignatureHeaderParse {
    if (value?.startsWith(SIGNATURE_HEADER_PREFIX) !== true) return { kind: 'invalid' };
    const signature = Ed25519Signature.safeParse(value.slice(SIGNATURE_HEADER_PREFIX.length));
    return signature.success ? { kind: 'ok', signature: signature.data } : { kind: 'invalid' };
}

export interface VerifyHeartbeatInput {
    readonly rawBody: Bytes;
    readonly signatureHeader: string | null | undefined;
    /** From the request path, already parsed. */
    readonly engineId: EngineId;
    readonly publicKey: Bytes;
    /** `null` before the first accepted heartbeat. */
    readonly lastSeq: number | null;
    /** From the caller's `Clock`. */
    readonly now: Timestamp;
}

export type HeartbeatVerification =
    | { readonly kind: 'accepted'; readonly heartbeat: Heartbeat }
    | { readonly kind: 'bad-signature-header' }
    | { readonly kind: 'bad-signature' }
    | { readonly kind: 'invalid-body' }
    | { readonly kind: 'engine-mismatch' }
    | { readonly kind: 'replayed-seq' }
    | { readonly kind: 'stale-ts'; readonly serverTime: Timestamp };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The dashboard's check on every heartbeat, in this order: size cap, header, signature over the raw bytes, then
 * (never before) UTF-8, JSON and the strict schema, then path engine ID equals body engine ID, `seq > lastSeq`, and
 * `|now − ts| ≤ 120 s`. A body over 4 KiB is `invalid-body` without being hashed.
 */
export async function verifyHeartbeat(input: VerifyHeartbeatInput): Promise<HeartbeatVerification> {
    if (input.rawBody.length > HEARTBEAT_MAX_BODY_BYTES) return { kind: 'invalid-body' };
    const header = parseSignatureHeader(input.signatureHeader);
    if (header.kind === 'invalid') return { kind: 'bad-signature-header' };
    const signed = await heartbeatInput(input.rawBody);
    if (!verifyEd25519(input.publicKey, signed, ed25519SignatureToBytes(header.signature))) {
        return { kind: 'bad-signature' };
    }
    const heartbeat = parseBody(input.rawBody);
    if (heartbeat === undefined) return { kind: 'invalid-body' };
    if (heartbeat.engineId !== input.engineId) return { kind: 'engine-mismatch' };
    if (input.lastSeq !== null && heartbeat.seq <= input.lastSeq) return { kind: 'replayed-seq' };
    if (!(Math.abs(Date.parse(input.now) - Date.parse(heartbeat.ts)) <= HEARTBEAT_MAX_SKEW_MS)) {
        return { kind: 'stale-ts', serverTime: input.now };
    }
    return { kind: 'accepted', heartbeat };
}

function parseBody(rawBody: Bytes): Heartbeat | undefined {
    let json: unknown;
    try {
        json = JSON.parse(utf8.decode(rawBody));
    } catch {
        return undefined;
    }
    const parsed = Heartbeat.safeParse(json);
    return parsed.success ? parsed.data : undefined;
}
