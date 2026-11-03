import type { AccessRequest, ClientInfo, Member } from '@ptbk/engine-api';
import { MAX_PENDING_ACCESS_REQUESTS } from '@ptbk/engine-api';
import type { InMemoryEngineController } from '@ptbk/engine-api/in-memory';
import type { Bytes, EngineId, HeartbeatAck } from '@ptbk/protocol';
import {
    ACCESS_TICKET_MAX_LIFETIME_MS,
    ACCESS_TICKET_MAX_SKEW_MS,
    MAX_HEARTBEAT_ACKS,
    Timestamp,
    encodeBase64Url,
    verifyAccessTicket,
    verifyMemberRevocation,
} from '@ptbk/protocol';
import type { AccessTicket } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { Logger } from '../logger';
import type { Random } from '../random';
import type { Challenges, PasskeyCeremonies, PasskeyCredential, RelyingParty } from './passkey-ceremonies';
import type { PasskeyStore } from './passkey-gateway';
import { passkeyName } from './passkey-gateway';
import type { SessionStore } from './sessions';

export type JoinEngine = Pick<
    InMemoryEngineController,
    'inspect' | 'requestAccess' | 'revokeDashboardMember' | 'recordAudit'
>;

export type TicketRefusal = 'invalid' | 'expired' | 'used' | 'already-member' | 'full';

export type JoinOptionsOutcome =
    { readonly kind: 'options'; readonly options: unknown } | { readonly kind: TicketRefusal };

export type JoinOutcome =
    | { readonly kind: 'waiting'; readonly code: string; readonly request: string }
    | { readonly kind: TicketRefusal | 'not-verified' };

export type JoinStatus =
    { readonly kind: 'waiting' | 'declined' | 'unknown' } | { readonly kind: 'approved'; readonly token: string };

export interface JoinGateway {
    options(input: { readonly ticket: string; readonly rp: RelyingParty }): Promise<JoinOptionsOutcome>;
    /** Registers the passkey and stores the pending request; the ticket is spent only if the passkey verifies. */
    complete(input: {
        readonly ticket: string;
        readonly response: unknown;
        readonly rp: RelyingParty;
    }): Promise<JoinOutcome>;
    /**
     * What the waiting page polls; once approved it signs the person in, once. While still waiting it holds the answer
     * up to `holdMs`, looking again each second, so the page needs no timer of its own.
     */
    status(input: {
        readonly request: string;
        readonly client: ClientInfo;
        readonly holdMs?: number;
        readonly signal?: AbortSignal;
    }): Promise<JoinStatus>;
    /** Catches up with approvals and removals made through the engine API, for sign-in and the heartbeat. */
    settle(): Promise<void>;
    /** Verifies and applies the revocations in a heartbeat reply; ones that do not verify are ignored, never acked. */
    applyRevocations(tokens: readonly string[]): Promise<void>;
    /** Whether the engine pinned a member key, and so speaks heartbeat v2. */
    enabled(): boolean;
    pendingRequests(): number;
    /** The acks for the next heartbeat, oldest first. */
    acks(): readonly HeartbeatAck[];
    /** The dashboard accepted a heartbeat carrying these acks. */
    acked(ids: readonly string[]): void;
}

export interface JoinGatewayDeps {
    readonly engine: () => JoinEngine;
    readonly engineId: EngineId;
    /** The pinned dashboard member key, read per call: registration may complete after startup. */
    readonly memberKey: () => Bytes | null;
    readonly passkeys: PasskeyStore;
    readonly sessions: SessionStore;
    readonly ceremonies: PasskeyCeremonies;
    readonly challenges: Challenges;
    readonly random: Random;
    /** Real time: tickets are stamped by the dashboard's clock. */
    readonly clock: Clock;
    /** The engine's own time, which its requests' `expiresAt` follow (the mock's simulation clock). */
    readonly engineNowMs: () => number;
    readonly logger: Logger;
}

/** What the engine remembers of one ticket after its request was stored, until the outcome is acked and polled. */
interface Joining {
    readonly ticketId: string;
    readonly requestId: AccessRequest['id'];
    readonly dashboardUserId: string;
    readonly credential: PasskeyCredential;
    state: 'pending' | 'joined' | 'closed';
    readonly createdMs: number;
}

const RP_NAME = 'Promptbook engine';
const ID_BYTES = 16;
/** Spent ticket IDs are kept a little longer than any ticket can live. */
const SPENT_TICKET_MS = ACCESS_TICKET_MAX_LIFETIME_MS + 2 * ACCESS_TICKET_MAX_SKEW_MS;
/** How long a request's outcome waits for its browser to poll; a request itself expires after 7 days. */
const JOINING_MS = 8 * 24 * 60 * 60 * 1000;
/** Revocation outcomes remembered, so a resent revocation whose ack got lost is acked the same way again. */
const MAX_REMEMBERED_REVOCATIONS = 1_000;
const CODE_RANGE = 1_000_000;
const STATUS_RECHECK_MS = 1000;
const UINT32_RANGE = 2 ** 32;

function iso(ms: number): Timestamp {
    return Timestamp.parse(new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));
}

function activeMemberOf(members: readonly Member[], dashboardUserId: string): Member | undefined {
    return members.find((member) => member.dashboardUserId === dashboardUserId && member.status === 'active');
}

/**
 * The gateway's side of teams (ADR 0018): the join page turns a dashboard ticket and a new passkey into a pending
 * request, approval through the engine API makes the person a member, and the heartbeat reports both ways. The engine
 * API's lists stay the authority: this keeps only what the gateway needs to sign the person in and to ack outcomes.
 */
export function createJoinGateway(deps: JoinGatewayDeps): JoinGateway {
    const { logger } = deps;
    const spentTickets = new Map<string, number>();
    /** By `ticketId`; joined entries stay, so a removal on the engine can be acked. */
    const joining = new Map<string, Joining>();
    /** The waiting page's opaque token, by which it polls, to the ticket; spent by the sign-in it leads to. */
    const requests = new Map<string, string>();
    const revocations = new Map<string, HeartbeatAck['outcome']>();
    const pendingAcks = new Map<string, HeartbeatAck['outcome']>();

    function sweep(nowMs: number): void {
        for (const [ticketId, untilMs] of spentTickets) if (untilMs <= nowMs) spentTickets.delete(ticketId);
        for (const [ticketId, entry] of joining) {
            if (entry.state === 'closed' && entry.createdMs + JOINING_MS <= nowMs) joining.delete(ticketId);
        }
        for (const [request, ticketId] of requests) if (!joining.has(ticketId)) requests.delete(request);
    }

    function ack(id: string, outcome: HeartbeatAck['outcome']): void {
        pendingAcks.delete(id);
        pendingAcks.set(id, outcome);
    }

    function liveRequests(): readonly AccessRequest[] {
        const nowMs = deps.engineNowMs();
        return deps
            .engine()
            .inspect()
            .accessRequests.filter((request) => Date.parse(request.expiresAt) > nowMs);
    }

    /** The ticket's checks, in the order the gateway contract gives; spent tickets are refused by the caller's ID. */
    async function check(token: string): Promise<
        | { readonly kind: 'ok'; readonly ticket: AccessTicket }
        | {
              readonly kind: TicketRefusal;
          }
    > {
        const memberKey = deps.memberKey();
        if (memberKey === null) return { kind: 'invalid' };
        const verification = await verifyAccessTicket({
            token,
            memberKey,
            engineId: deps.engineId,
            now: iso(deps.clock.nowMs()),
        });
        if (verification.kind === 'expired' || verification.kind === 'not-yet-valid') return { kind: 'expired' };
        if (verification.kind !== 'accepted') return { kind: 'invalid' };
        const { ticket } = verification;
        sweep(deps.clock.nowMs());
        if (spentTickets.has(ticket.ticketId)) return { kind: 'used' };
        if (activeMemberOf(deps.engine().inspect().members, ticket.dashboardUserId) !== undefined) {
            return { kind: 'already-member' };
        }
        // The same person's new ticket replaces their request, so it never counts against the cap.
        const replacing = [...joining.values()].some(
            (entry) => entry.state === 'pending' && entry.dashboardUserId === ticket.dashboardUserId,
        );
        if (!replacing && liveRequests().length >= MAX_PENDING_ACCESS_REQUESTS) return { kind: 'full' };
        return { kind: 'ok', ticket };
    }

    /** Six digits from a CSPRNG, uniform: values past the last whole multiple of a million are drawn again. */
    function sixDigitCode(): string {
        const limit = UINT32_RANGE - (UINT32_RANGE % CODE_RANGE);
        for (;;) {
            const value = new DataView(deps.random.bytes(4).buffer).getUint32(0);
            if (value < limit) return String(value % CODE_RANGE).padStart(6, '0');
        }
    }

    /** Puts the approved person's passkey where sign-in finds it, under the passkey the engine API created. */
    async function materialize(entry: Joining, member: Member): Promise<void> {
        const stored = new Set((await deps.passkeys.list()).map(({ passkeyId }) => passkeyId));
        const passkey = deps
            .engine()
            .inspect()
            .passkeys.filter(({ memberId, id }) => memberId === member.id && !stored.has(id))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (passkey === undefined) return;
        await deps.passkeys.add({
            ...entry.credential,
            passkeyId: passkey.id,
            memberId: member.id,
            name: passkey.name,
            createdAt: passkey.createdAt,
            member: { displayName: member.displayName, role: member.role, createdAt: member.createdAt },
        });
    }

    async function settle(): Promise<void> {
        const snapshot = deps.engine().inspect();
        const nowMs = deps.engineNowMs();
        const live = new Set(
            snapshot.accessRequests.filter((request) => Date.parse(request.expiresAt) > nowMs).map(({ id }) => id),
        );
        for (const entry of joining.values()) {
            const member = activeMemberOf(snapshot.members, entry.dashboardUserId);
            if (entry.state === 'pending') {
                if (live.has(entry.requestId)) continue;
                if (member === undefined) {
                    entry.state = 'closed';
                    ack(entry.ticketId, 'declined');
                    continue;
                }
                await materialize(entry, member);
                entry.state = 'joined';
                ack(entry.ticketId, 'approved');
            } else if (entry.state === 'joined' && member === undefined) {
                entry.state = 'closed';
                ack(entry.ticketId, 'removed');
            }
        }
    }

    function isWaiting(request: string): boolean {
        const ticketId = requests.get(request);
        return ticketId !== undefined && joining.get(ticketId)?.state === 'pending';
    }

    async function applyRevocation(token: string, memberKey: Bytes): Promise<void> {
        const verification = await verifyMemberRevocation({ token, memberKey, engineId: deps.engineId });
        if (verification.kind !== 'accepted') {
            logger.warn('member-revocation.ignored', { reason: verification.kind });
            return;
        }
        const { revocationId, dashboardUserId } = verification.revocation;
        const remembered = revocations.get(revocationId);
        if (remembered !== undefined) {
            ack(revocationId, remembered);
            return;
        }
        const engine = deps.engine();
        const member = activeMemberOf(engine.inspect().members, dashboardUserId);
        const outcome = engine.revokeDashboardMember(dashboardUserId);
        if (outcome === 'revoked' && member !== undefined) {
            engine.recordAudit({
                actor: { kind: 'system' },
                action: 'member.revoke',
                target: { kind: 'member', id: member.id, name: member.displayName },
                outcome: 'success',
                client: null,
                details: { by: 'dashboard' },
            });
        }
        // Removed by the organization, so the ticket it joined with is not reported as removed on the engine too. A
        // refused revocation leaves the member in place: a later removal on the engine must still be acked, or the
        // dashboard lists them as refused forever. Their pending request is gone either way.
        for (const entry of joining.values()) {
            if (entry.dashboardUserId !== dashboardUserId) continue;
            if (outcome === 'revoked' || entry.state === 'pending') entry.state = 'closed';
        }
        if (revocations.size >= MAX_REMEMBERED_REVOCATIONS) {
            const oldest = revocations.keys().next();
            if (oldest.done !== true) revocations.delete(oldest.value);
        }
        revocations.set(revocationId, outcome);
        ack(revocationId, outcome);
        logger.info('member-revocation.applied', { outcome });
    }

    return {
        async options({ ticket: token, rp }) {
            const checked = await check(token);
            if (checked.kind !== 'ok') return checked;
            const options = await deps.ceremonies.registrationOptions({
                rp,
                rpName: RP_NAME,
                userHandle: encodeBase64Url(deps.random.bytes(ID_BYTES)),
                userName: checked.ticket.displayName,
                challenge: deps.challenges.issue('join', checked.ticket.ticketId),
                excludeCredentialIds: [],
            });
            return { kind: 'options', options };
        },

        async complete({ ticket: token, response, rp }) {
            const checked = await check(token);
            if (checked.kind !== 'ok') return checked;
            const { ticket } = checked;
            const credential = await deps.ceremonies.verifyRegistration({
                rp,
                response,
                expectChallenge: (challenge) => deps.challenges.take(challenge, 'join', ticket.ticketId),
            });
            if (credential === null) return { kind: 'not-verified' };
            // Spent here, after the passkey verified and after the awaits: of two racing browsers only one gets through.
            if (spentTickets.has(ticket.ticketId)) return { kind: 'used' };
            const nowMs = deps.clock.nowMs();
            spentTickets.set(ticket.ticketId, nowMs + SPENT_TICKET_MS);
            const code = sixDigitCode();
            let accessRequest: AccessRequest;
            try {
                accessRequest = deps.engine().requestAccess({
                    dashboardUserId: ticket.dashboardUserId,
                    displayName: ticket.displayName,
                    email: ticket.email,
                    proposedRole: ticket.proposedRole,
                    code,
                    passkey: {
                        name: passkeyName(credential),
                        authenticator:
                            credential.attachment === null
                                ? null
                                : { attachment: credential.attachment, backedUp: credential.backedUp },
                    },
                });
            } catch {
                return { kind: 'full' };
            }
            for (const [ticketId, entry] of joining) {
                if (entry.dashboardUserId === ticket.dashboardUserId && entry.state === 'pending') {
                    joining.delete(ticketId);
                }
            }
            const request = encodeBase64Url(deps.random.bytes(ID_BYTES));
            requests.set(request, ticket.ticketId);
            joining.set(ticket.ticketId, {
                ticketId: ticket.ticketId,
                requestId: accessRequest.id,
                dashboardUserId: ticket.dashboardUserId,
                credential,
                state: 'pending',
                createdMs: nowMs,
            });
            logger.info('access-request.created', {});
            return { kind: 'waiting', code, request };
        },

        async status({ request, client, holdMs = 0, signal }) {
            const untilMs = deps.clock.nowMs() + holdMs;
            await settle();
            while (isWaiting(request) && deps.clock.nowMs() < untilMs && signal?.aborted !== true) {
                await new Promise<void>((resolve) => {
                    const cancel = deps.clock.setTimeout(resolve, STATUS_RECHECK_MS);
                    signal?.addEventListener(
                        'abort',
                        () => {
                            cancel();
                            resolve();
                        },
                        { once: true },
                    );
                });
                await settle();
            }
            const ticketId = requests.get(request);
            const entry = ticketId === undefined ? undefined : joining.get(ticketId);
            if (entry === undefined) return { kind: 'unknown' };
            if (entry.state === 'pending') return { kind: 'waiting' };
            const member = activeMemberOf(deps.engine().inspect().members, entry.dashboardUserId);
            if (entry.state === 'closed' || member === undefined) return { kind: 'declined' };
            // The token signs in once; the page then holds a session like any other.
            requests.delete(request);
            const passkeyId = (await deps.passkeys.list()).find(
                ({ credentialId }) => credentialId === entry.credential.credentialId,
            )?.passkeyId;
            const signedIn = deps.sessions.signIn({
                memberId: member.id,
                permissions: null,
                client,
                ...(passkeyId === undefined ? {} : { passkeyId }),
            });
            return { kind: 'approved', token: signedIn.token };
        },

        settle,

        async applyRevocations(tokens) {
            const memberKey = deps.memberKey();
            if (memberKey === null) return;
            for (const token of tokens) await applyRevocation(token, memberKey);
        },

        enabled: () => deps.memberKey() !== null,
        pendingRequests: () => liveRequests().length,
        acks: () => [...pendingAcks].slice(0, MAX_HEARTBEAT_ACKS).map(([id, outcome]) => ({ id, outcome })),
        acked(ids) {
            for (const id of ids) pendingAcks.delete(id);
        },
    };
}
