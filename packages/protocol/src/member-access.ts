import { z } from 'zod';

import { decodeBase64Url, encodeBase64Url } from './base64url';
import type { Bytes } from './bytes';
import { utf8Encode } from './bytes';
import type { Signer } from './ed25519';
import { verifyEd25519 } from './ed25519';
import { ED25519_SIGNATURE_BYTES, EngineId, Timestamp } from './ids';
import type { SigningContext } from './signing-input';
import { SIGNING_CONTEXT, signingInput } from './signing-input';

/** An access ticket lives at most this long: long enough to create a passkey, short enough not to be worth stealing. */
export const ACCESS_TICKET_MAX_LIFETIME_MS = 15 * 60 * 1000;
/** Clock skew tolerated before `issuedAt`. */
export const ACCESS_TICKET_MAX_SKEW_MS = 120_000;
/** Bounds the compact form (`<body>.<signature>`) before anything decodes it. */
export const SIGNED_MEMBER_MESSAGE_MAX_LENGTH = 2048;

/** Random IDs the dashboard issues (`ticketId`, `revocationId`); the heartbeat acks them, so they carry no meaning. */
export const DashboardIssuedId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
/** Opaque to the engine; the same pattern as the engine API's `DashboardUserId`. */
export const DashboardUserId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const PROPOSED_MEMBER_ROLES = ['admin', 'member'] as const;

/**
 * What the dashboard vouches for when it sends an invited person to an engine's join page: who they are (hints the
 * approver sees, never proof) and which engine. The engine accepts it once (`ticketId`) and only before `expiresAt`.
 */
export const AccessTicket = z
    .strictObject({
        v: z.literal(1),
        engineId: EngineId,
        ticketId: DashboardIssuedId,
        dashboardUserId: DashboardUserId,
        displayName: z.string().min(1).max(128),
        email: z.string().min(3).max(254),
        proposedRole: z.enum(PROPOSED_MEMBER_ROLES),
        issuedAt: Timestamp,
        expiresAt: Timestamp,
    })
    .refine(
        ({ issuedAt, expiresAt }) => {
            const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
            return lifetime > 0 && lifetime <= ACCESS_TICKET_MAX_LIFETIME_MS;
        },
        { message: 'expiresAt must follow issuedAt by at most 15 minutes' },
    );
export type AccessTicket = z.infer<typeof AccessTicket>;

/** The dashboard takes back access it brought: the engine disables the member who joined as `dashboardUserId`. */
export const MemberRevocation = z.strictObject({
    v: z.literal(1),
    engineId: EngineId,
    revocationId: DashboardIssuedId,
    dashboardUserId: DashboardUserId,
    issuedAt: Timestamp,
});
export type MemberRevocation = z.infer<typeof MemberRevocation>;

async function digestInput(context: SigningContext, body: Bytes): Promise<Bytes> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
    return signingInput(context, digest);
}

/** `<base64url body>.<base64url signature>`, the signature over `signingInput(context, sha256(body))`. */
async function signCompact(context: SigningContext, signer: Signer, body: Bytes, signal?: AbortSignal) {
    const signature = await signer.sign(await digestInput(context, body), signal);
    return `${encodeBase64Url(body)}.${encodeBase64Url(signature)}`;
}

type Opened = { readonly kind: 'ok'; readonly json: unknown } | { readonly kind: 'malformed' | 'bad-signature' };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Size, shape, then the signature over the exact body bytes, and only then UTF-8 and JSON. */
async function openCompact(context: SigningContext, token: string, memberKey: Bytes): Promise<Opened> {
    if (token.length > SIGNED_MEMBER_MESSAGE_MAX_LENGTH) return { kind: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 2) return { kind: 'malformed' };
    const body = decodeBase64Url(parts[0] ?? '');
    const signature = decodeBase64Url(parts[1] ?? '');
    if (body.kind !== 'ok' || signature.kind !== 'ok' || signature.bytes.length !== ED25519_SIGNATURE_BYTES) {
        return { kind: 'malformed' };
    }
    if (!verifyEd25519(memberKey, await digestInput(context, body.bytes), signature.bytes)) {
        return { kind: 'bad-signature' };
    }
    try {
        return { kind: 'ok', json: JSON.parse(utf8.decode(body.bytes)) };
    } catch {
        return { kind: 'malformed' };
    }
}

/** Signs a ticket with the dashboard's member key; throws on a ticket outside the schema, which is a dashboard bug. */
export async function signAccessTicket(signer: Signer, ticket: AccessTicket, signal?: AbortSignal): Promise<string> {
    const body = utf8Encode(JSON.stringify(AccessTicket.parse(ticket)));
    return signCompact(SIGNING_CONTEXT.accessTicket, signer, body, signal);
}

export interface VerifyAccessTicketInput {
    readonly token: string;
    /** The dashboard member key the engine pinned at registration. */
    readonly memberKey: Bytes;
    readonly engineId: EngineId;
    readonly now: Timestamp;
}

export type AccessTicketVerification =
    | { readonly kind: 'accepted'; readonly ticket: AccessTicket }
    | {
          readonly kind:
              'malformed' | 'bad-signature' | 'invalid-body' | 'engine-mismatch' | 'not-yet-valid' | 'expired';
      };

/**
 * The join page's check, in this order: size and shape, signature, strict schema, engine, then time. The caller then
 * refuses a `ticketId` it has seen before; only it knows which ones it has.
 */
export async function verifyAccessTicket(input: VerifyAccessTicketInput): Promise<AccessTicketVerification> {
    const opened = await openCompact(SIGNING_CONTEXT.accessTicket, input.token, input.memberKey);
    if (opened.kind !== 'ok') return { kind: opened.kind };
    const ticket = AccessTicket.safeParse(opened.json);
    if (!ticket.success) return { kind: 'invalid-body' };
    if (ticket.data.engineId !== input.engineId) return { kind: 'engine-mismatch' };
    const now = Date.parse(input.now);
    if (now < Date.parse(ticket.data.issuedAt) - ACCESS_TICKET_MAX_SKEW_MS) return { kind: 'not-yet-valid' };
    if (now >= Date.parse(ticket.data.expiresAt)) return { kind: 'expired' };
    return { kind: 'accepted', ticket: ticket.data };
}

/**
 * Clock skew tolerated when an engine compares a revocation's `issuedAt` (the dashboard's clock) with a join time (its
 * own). The heartbeat's tolerance: an engine whose heartbeats are accepted runs within it of the dashboard, so a
 * revocation issued after the person joined is never taken for an older one.
 */
export const MEMBER_REVOCATION_MAX_SKEW_MS = 120_000;

/**
 * Whether a revocation was issued before the targeted person's current membership began, beyond the skew: when the
 * engine stored the access request that made them a member, or that is still pending. Such a revocation was meant for
 * an earlier membership the organization has since given back; the engine applies nothing and acks it `not-found`.
 */
export function revocationPredates(revocation: Pick<MemberRevocation, 'issuedAt'>, joinedAt: Timestamp): boolean {
    return Date.parse(revocation.issuedAt) < Date.parse(joinedAt) - MEMBER_REVOCATION_MAX_SKEW_MS;
}

export async function signMemberRevocation(
    signer: Signer,
    revocation: MemberRevocation,
    signal?: AbortSignal,
): Promise<string> {
    const body = utf8Encode(JSON.stringify(MemberRevocation.parse(revocation)));
    return signCompact(SIGNING_CONTEXT.memberRevocation, signer, body, signal);
}

export type MemberRevocationVerification =
    | { readonly kind: 'accepted'; readonly revocation: MemberRevocation }
    | { readonly kind: 'malformed' | 'bad-signature' | 'invalid-body' | 'engine-mismatch' };

/**
 * A revocation carries no expiry: the dashboard resends it until the heartbeat acks it, and applying it twice is
 * harmless (the second finds no member). One that does not verify is ignored and never acked.
 */
export async function verifyMemberRevocation(input: {
    readonly token: string;
    readonly memberKey: Bytes;
    readonly engineId: EngineId;
}): Promise<MemberRevocationVerification> {
    const opened = await openCompact(SIGNING_CONTEXT.memberRevocation, input.token, input.memberKey);
    if (opened.kind !== 'ok') return { kind: opened.kind };
    const revocation = MemberRevocation.safeParse(opened.json);
    if (!revocation.success) return { kind: 'invalid-body' };
    if (revocation.data.engineId !== input.engineId) return { kind: 'engine-mismatch' };
    return { kind: 'accepted', revocation: revocation.data };
}
