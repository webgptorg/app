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
import { DashboardIssuedId, DashboardUserId, SIGNED_MEMBER_MESSAGE_MAX_LENGTH } from './member-access';
import { OwnerHandoff } from './owner-handoff';
import { SIGNING_CONTEXT, signingInput } from './signing-input';

export const HEARTBEAT_SIGNATURE_HEADER = 'Ptbk-Signature';
/**
 * 12 KiB since ADR 0027 (C-21), so `MAX_HEARTBEAT_ATTENTION` entries fit beside `MAX_HEARTBEAT_ACKS` acks even with
 * every ID at its longest; the ADR's 8 KiB fits only the dashboard's own, shorter IDs.
 */
export const HEARTBEAT_MAX_BODY_BYTES = 12 * 1024;
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
 * Whether the engine's own setup (`onboarding@1`) is finished: `pending` from pairing until the owner completes it in
 * the browser, however long they leave it. Absent from engines without browser setup, which the dashboard reads as
 * set up.
 */
export const SetupState = z.enum(['pending', 'done']);
export type SetupState = z.infer<typeof SetupState>;

/**
 * The public promise of what the dashboard learns about an engine: numbers and closed enums only, no names or free
 * text. `seq` only has to increase strictly; engines send `max(lastSeq + 1, Date.now())` so one that loses its state
 * but keeps its key is not locked out.
 */
const heartbeatShape = {
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
    setup: SetupState.optional(),
    /** `ready` while the pairing tab may send the owner to the setup page (ADR 0023); see `OwnerHandoff`. */
    ownerHandoff: OwnerHandoff.optional(),
};

export const Heartbeat = z.strictObject({ v: z.literal(1), ...heartbeatShape });
export type Heartbeat = z.infer<typeof Heartbeat>;

export const MAX_HEARTBEAT_ACKS = 32;
export const HEARTBEAT_ACK_OUTCOMES = [
    'approved',
    'declined',
    'removed',
    'revoked',
    'refused-owner',
    'refused-disabled',
    'not-found',
] as const;

/**
 * What became of something the dashboard issued: a ticket (`approved`, `declined`, `removed` once that member is
 * removed on the engine) or a revocation (`revoked`, `refused-owner`, `refused-disabled`, `not-found`).
 */
export const HeartbeatAck = z.strictObject({ id: DashboardIssuedId, outcome: z.enum(HEARTBEAT_ACK_OUTCOMES) });
export type HeartbeatAck = z.infer<typeof HeartbeatAck>;

export const MAX_HEARTBEAT_ATTENTION = 64;
/**
 * What an engine's inbox (`notifications@1`) holds that someone has not seen yet (ADR 0027). Closed: a new kind is an
 * addition in the same version, accepted by the dashboard before any engine sends it.
 */
export const ATTENTION_KINDS = ['agent-waiting', 'task-failed', 'tool-sign-in'] as const;
export const AttentionKind = z.enum(ATTENTION_KINDS);
export type AttentionKind = z.infer<typeof AttentionKind>;

/**
 * `count` open items of `kind` that the person has not seen in the engine UI yet. `to` is the dashboard user they are
 * for, from the access ticket they joined with; absent, the items are project-wide, for the project's managers.
 */
export const HeartbeatAttention = z.strictObject({
    to: DashboardUserId.optional(),
    kind: AttentionKind,
    count: z.int().min(1).max(MAX_HEARTBEAT_COUNT),
});
export type HeartbeatAttention = z.infer<typeof HeartbeatAttention>;

const attentionKey = ({ to, kind }: HeartbeatAttention): string => `${to ?? ''}\u0000${kind}`;

/** At most one entry per person and kind, so a count is never ambiguous. */
const Attention = z
    .array(HeartbeatAttention)
    .max(MAX_HEARTBEAT_ATTENTION)
    .refine((entries) => new Set(entries.map(attentionKey)).size === entries.length, {
        message: 'one entry per person and kind',
    });

/**
 * v1 plus what teams need (ADR 0018): the number of pending access requests, and acks keyed by IDs the dashboard
 * issued, so the dashboard still learns no names or free text. An engine sends v2 only once it handles access tickets
 * and revocations; the dashboard answers it with a `HeartbeatReply`.
 */
export const HeartbeatV2 = z.strictObject({
    v: z.literal(2),
    ...heartbeatShape,
    accessRequests: Count,
    acks: z.array(HeartbeatAck).max(MAX_HEARTBEAT_ACKS),
    /**
     * Present, possibly empty, while the owner lets the engine share unseen counts (ADR 0027); absent while they do
     * not, which strict mode starts with. Only v2 has it: only an engine that handles tickets knows dashboard users.
     */
    attention: Attention.optional(),
});
export type HeartbeatV2 = z.infer<typeof HeartbeatV2>;

export const AnyHeartbeat = z.discriminatedUnion('v', [Heartbeat, HeartbeatV2]);
export type AnyHeartbeat = z.infer<typeof AnyHeartbeat>;

export const MAX_HEARTBEAT_REVOCATIONS = 32;
export const HEARTBEAT_REPLY_MAX_BYTES = 72 * 1024;

const replyShape = {
    v: z.literal(1),
    /** Signed `MemberRevocation`s in compact form, resent until a heartbeat acks them. */
    revocations: z.array(z.string().max(SIGNED_MEMBER_MESSAGE_MAX_LENGTH)).max(MAX_HEARTBEAT_REVOCATIONS),
};

/** The dashboard's 200 answer to an accepted v2 heartbeat; a v1 heartbeat still gets 204 with no body. */
export const HeartbeatReply = z.strictObject(replyShape);
export type HeartbeatReply = z.infer<typeof HeartbeatReply>;
/** What the engine parses the reply with: known fields validated, unknown ones stripped (ADR 0010 §3). */
export const TolerantHeartbeatReply = z.object(replyShape);

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
    const heartbeat: Heartbeat = Heartbeat.parse({ v: 1, ...heartbeatFields(input) });
    return utf8Encode(JSON.stringify(heartbeat));
}

export interface HeartbeatV2Input extends HeartbeatInput {
    readonly accessRequests: number;
    readonly acks: readonly HeartbeatAck[];
    /** Leave out while the owner has sharing switched off; an empty list says it is on and nothing waits. */
    readonly attention?: readonly HeartbeatAttention[];
}

/** As `buildHeartbeat`, for an engine that handles access tickets and revocations. */
export function buildHeartbeatV2(input: HeartbeatV2Input): Bytes {
    const heartbeat: HeartbeatV2 = HeartbeatV2.parse({
        v: 2,
        ...heartbeatFields(input),
        accessRequests: input.accessRequests,
        acks: input.acks,
        ...(input.attention === undefined ? {} : { attention: input.attention.map(attentionFields) }),
    });
    return utf8Encode(JSON.stringify(heartbeat));
}

function attentionFields({ to, kind, count }: HeartbeatAttention): HeartbeatAttention {
    return { ...(to === undefined ? {} : { to }), kind, count };
}

/** Only the fields the schema knows, in its order, so extra properties on the input never reach the wire. */
function heartbeatFields(input: HeartbeatInput) {
    return {
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
        ...(input.setup === undefined ? {} : { setup: input.setup }),
        ...(input.ownerHandoff === undefined ? {} : { ownerHandoff: input.ownerHandoff }),
    };
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
    | { readonly kind: 'accepted'; readonly heartbeat: AnyHeartbeat }
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
 * `|now − ts| ≤ 120 s`. A body over `HEARTBEAT_MAX_BODY_BYTES` is `invalid-body` without being hashed.
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

function parseBody(rawBody: Bytes): AnyHeartbeat | undefined {
    let json: unknown;
    try {
        json = JSON.parse(utf8.decode(rawBody));
    } catch {
        return undefined;
    }
    const parsed = AnyHeartbeat.safeParse(json);
    return parsed.success ? parsed.data : undefined;
}
