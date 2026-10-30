import type { EngineId, HeartbeatV2, Signer } from '@ptbk/protocol';
import {
    Timestamp,
    createWebCryptoSigner,
    encodeBase64Url,
    generateEd25519KeyPair,
    signMemberRevocation,
} from '@ptbk/protocol';

import type { PlatformCheck, PlatformCheckContext, PlatformSuite } from '../../harness/platform';
import type { LinkedEngine } from '../support';
import { attemptWait, startLinkedEngine } from '../support';

export const SUITE = 'member-access';

/**
 * How many heartbeats a check waits for an ack, or watches to see none: the revocation goes out in the reply to one
 * beat and its ack rides on a later one.
 */
const BEATS_TO_ACK = 3;

type Started =
    | { readonly kind: 'v2'; readonly linked: LinkedEngine; readonly engineId: EngineId }
    | { readonly kind: 'done'; readonly outcome: Awaited<ReturnType<PlatformCheck['run']>> };

/** A linked engine that sends heartbeat v2, or the outcome to report: a v1 engine has no teams support to check. */
async function startV2Engine(ctx: PlatformCheckContext): Promise<Started> {
    const linked = await startLinkedEngine(ctx);
    const first = await attemptWait(ctx, linked, 'send an accepted heartbeat', () =>
        linked.dashboard.heartbeats.find((beat) => beat.verification?.kind === 'accepted'),
    );
    if (!first.ok) return { kind: 'done', outcome: { kind: 'fail', detail: first.reason } };
    const verification = first.value.verification;
    if (verification?.kind !== 'accepted' || verification.heartbeat.v !== 2) {
        return { kind: 'done', outcome: { kind: 'skip', reason: 'heartbeat-v1: the engine does not support teams' } };
    }
    return { kind: 'v2', linked, engineId: verification.heartbeat.engineId };
}

function randomId(ctx: PlatformCheckContext): string {
    return encodeBase64Url(ctx.random.bytes(16));
}

async function revocation(ctx: PlatformCheckContext, signer: Signer, engineId: EngineId) {
    const id = randomId(ctx);
    const token = await signMemberRevocation(signer, {
        v: 1,
        engineId,
        revocationId: id,
        dashboardUserId: `conformance-${randomId(ctx)}`,
        issuedAt: Timestamp.parse(new Date().toISOString()),
    });
    return { id, token };
}

function acksOf(linked: LinkedEngine, since: number): HeartbeatV2['acks'] {
    return linked.dashboard.heartbeats
        .filter((beat) => beat.at >= since)
        .flatMap((beat) =>
            beat.verification?.kind === 'accepted' && beat.verification.heartbeat.v === 2
                ? beat.verification.heartbeat.acks
                : [],
        );
}

function acceptedBeatsSince(linked: LinkedEngine, since: number): number {
    return linked.dashboard.heartbeats.filter((beat) => beat.at >= since && beat.verification?.kind === 'accepted')
        .length;
}

const timeoutMs: PlatformCheck['timeoutMs'] = (expectations) =>
    expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs * (BEATS_TO_ACK + 2);

export const unknownMemberAcked: PlatformCheck = {
    id: 'member-access.revocation.unknown-member-acked',
    suite: SUITE,
    title: 'A valid revocation for nobody on the engine is acked not-found in a later heartbeat v2',
    timeoutMs,
    async run(ctx) {
        const started = await startV2Engine(ctx);
        if (started.kind === 'done') return started.outcome;
        const { linked, engineId } = started;
        const { id, token } = await revocation(ctx, linked.dashboard.memberSigner, engineId);
        const since = Date.now();
        linked.dashboard.queueRevocation(engineId, id, token);
        const ack = await attemptWait(
            ctx,
            linked,
            'ack the revocation',
            () => acksOf(linked, since).find((candidate) => candidate.id === id),
            ctx.expectations.heartbeatIntervalMs * (BEATS_TO_ACK + 1),
        );
        if (!ack.ok) return { kind: 'fail', detail: ack.reason };
        return ack.value.outcome === 'not-found'
            ? { kind: 'pass' }
            : { kind: 'fail', detail: `the ack says ${ack.value.outcome}, not not-found` };
    },
};

/** Waits `BEATS_TO_ACK` accepted heartbeats after queuing and fails if any of them acks `id`. */
async function neverAcked(ctx: PlatformCheckContext, linked: LinkedEngine, id: string, since: number, what: string) {
    const watched = await attemptWait(
        ctx,
        linked,
        `send ${String(BEATS_TO_ACK)} heartbeats`,
        () => (acceptedBeatsSince(linked, since) >= BEATS_TO_ACK ? true : undefined),
        ctx.expectations.heartbeatIntervalMs * (BEATS_TO_ACK + 1),
    );
    if (!watched.ok) return { kind: 'fail' as const, detail: watched.reason };
    return acksOf(linked, since).some((ack) => ack.id === id)
        ? { kind: 'fail' as const, detail: `the engine acked ${what} instead of ignoring it` }
        : { kind: 'pass' as const };
}

export const forgedIgnored: PlatformCheck = {
    id: 'member-access.revocation.forged-ignored',
    suite: SUITE,
    title: 'A revocation signed by any key but the pinned member key is ignored and never acked',
    timeoutMs,
    async run(ctx) {
        const started = await startV2Engine(ctx);
        if (started.kind === 'done') return started.outcome;
        const { linked, engineId } = started;
        const forger = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
        const { id, token } = await revocation(ctx, forger, engineId);
        const since = Date.now();
        linked.dashboard.queueRevocation(engineId, id, token);
        return neverAcked(ctx, linked, id, since, 'a forged revocation');
    },
};

export const otherEngineIgnored: PlatformCheck = {
    id: 'member-access.revocation.other-engine-ignored',
    suite: SUITE,
    title: "A revocation signed for another engine is ignored and never acked, so one engine's cannot replay on another",
    timeoutMs,
    async run(ctx) {
        const started = await startV2Engine(ctx);
        if (started.kind === 'done') return started.outcome;
        const { linked, engineId } = started;
        const other = (engineId.startsWith('a') ? 'b' : 'a').repeat(26) as EngineId;
        const { id, token } = await revocation(ctx, linked.dashboard.memberSigner, other);
        const since = Date.now();
        linked.dashboard.queueRevocation(engineId, id, token);
        return neverAcked(ctx, linked, id, since, "another engine's revocation");
    },
};

/**
 * Acting as the dashboard with teams (ADR 0018): member revocations in the heartbeat reply. Tickets, the join page and
 * approval need a browser on the engine's origin and come with the reference join page (M-09).
 */
export const MEMBER_ACCESS_SUITE: PlatformSuite = {
    id: SUITE,
    checks: [unknownMemberAcked, forgedIgnored, otherEngineIgnored],
};
