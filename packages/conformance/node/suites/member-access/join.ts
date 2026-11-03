import {
    ENGINE_API_PREFIX,
    JOIN_OPTIONS_PATH,
    JOIN_PROBLEM,
    JOIN_STATUS_PATH,
    JOIN_VERIFY_PATH,
    MAX_ACCESS_CODE_ATTEMPTS,
    MAX_PENDING_ACCESS_REQUESTS,
} from '@ptbk/engine-api';
import type { AccessTicket, EngineId, HeartbeatV2, Signer } from '@ptbk/protocol';
import {
    Timestamp,
    createWebCryptoSigner,
    encodeBase64Url,
    generateEd25519KeyPair,
    signAccessTicket,
    signMemberRevocation,
} from '@ptbk/protocol';

import type { SessionCredential } from '../../../src/index';
import { createPasskey } from '../../fakes/authenticator';
import type { RegisteredEngine } from '../../fakes/dashboard';
import { startRegisteredEngine } from '../../fakes/dashboard';
import type { EngineApiEndpoint, PlatformCheck, PlatformCheckContext } from '../../harness/platform';
import { startTunnelRelay } from '../../tunnel/tunnel-relay';
import { attemptWait, quietly } from '../support';

const SUITE = 'member-access';
const TICKET_LIFETIME_MS = 15 * 60_000;
/** Far beyond the skew engines tolerate when comparing a revocation with a join (`MEMBER_REVOCATION_MAX_SKEW_MS`). */
const STALE_REVOCATION_MS = 10 * 60_000;
const RETRY_MS = 250;
const BEATS_TO_ACK = 3;

type Outcome = Awaited<ReturnType<PlatformCheck['run']>>;

interface Answer {
    readonly status: number;
    readonly code: string | null;
    readonly body: Record<string, unknown> | null;
}

/** An engine registered with a fake dashboard, reachable through a fake relay, that speaks heartbeat v2. */
export interface JoinableEngine {
    readonly registered: RegisteredEngine;
    readonly endpoint: EngineApiEndpoint;
    readonly engineId: EngineId;
    readonly ctx: PlatformCheckContext;
}

type Opened =
    { readonly kind: 'ok'; readonly engine: JoinableEngine } | { readonly kind: 'done'; readonly outcome: Outcome };

async function openJoinable(ctx: PlatformCheckContext): Promise<Opened> {
    const relay = ctx.use(await startTunnelRelay(ctx, { relays: 1 }));
    const registered = await startRegisteredEngine(ctx, { env: relay.env });
    const beat = await registered.nextAcceptedHeartbeat(0);
    const verification = beat.verification;
    if (verification?.kind !== 'accepted' || verification.heartbeat.v !== 2) {
        return { kind: 'done', outcome: { kind: 'skip', reason: 'heartbeat-v1: the engine does not support teams' } };
    }
    const endpoint = await relay.endpointFor(registered);
    return { kind: 'ok', engine: { registered, endpoint, engineId: registered.identity.engineId, ctx } };
}

function randomId(ctx: PlatformCheckContext): string {
    return encodeBase64Url(ctx.random.bytes(16));
}

/** A same-origin JSON request, as the join page or the engine UI sends it. */
async function call(
    engine: JoinableEngine,
    method: string,
    path: string,
    body: unknown,
    session: SessionCredential | null = null,
): Promise<Answer> {
    const headers: Record<string, string> = {
        Origin: engine.endpoint.baseUrl.origin,
        'Sec-Fetch-Site': 'same-origin',
        Accept: 'application/json, application/problem+json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session !== null) {
        if ('cookie' in session) headers['Cookie'] = session.cookie;
        else headers['Authorization'] = `Bearer ${session.bearer}`;
    }
    const response = await engine.endpoint.fetch(new URL(path, engine.endpoint.baseUrl), {
        method,
        headers,
        redirect: 'manual',
        signal: engine.ctx.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed: unknown = await response.json().catch(() => null);
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    const code = typeof record?.['code'] === 'string' ? record['code'] : null;
    return { status: response.status, code, body: record };
}

function ticket(engine: JoinableEngine, overrides: Partial<AccessTicket> = {}, signer?: Signer): Promise<string> {
    const issuedAt = Date.now();
    const iso = (ms: number) => Timestamp.parse(new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    return signAccessTicket(signer ?? engine.registered.dashboard.memberSigner, {
        v: 1,
        engineId: engine.engineId,
        ticketId: randomId(engine.ctx),
        dashboardUserId: `conformance-${randomId(engine.ctx)}`,
        displayName: 'Conformance Person',
        email: 'person@conformance.invalid',
        proposedRole: 'member',
        issuedAt: iso(issuedAt),
        expiresAt: iso(issuedAt + TICKET_LIFETIME_MS),
        ...overrides,
    });
}

type Joined =
    | { readonly kind: 'waiting'; readonly code: string; readonly request: string }
    | { readonly kind: 'refused'; readonly step: 'options' | 'verify'; readonly answer: Answer };

/** The join page's whole flow without a browser: options, a new passkey from a software authenticator, verify. */
async function join(engine: JoinableEngine, token: string): Promise<Joined> {
    const options = await call(engine, 'POST', JOIN_OPTIONS_PATH, { ticket: token });
    if (options.status !== 200) return { kind: 'refused', step: 'options', answer: options };
    const response = await createPasskey(options.body?.['options'], engine.endpoint.baseUrl.origin);
    const verify = await call(engine, 'POST', JOIN_VERIFY_PATH, { ticket: token, response });
    const code = verify.body?.['code'];
    const request = verify.body?.['request'];
    if (verify.status !== 201 || typeof code !== 'string' || typeof request !== 'string') {
        return { kind: 'refused', step: 'verify', answer: verify };
    }
    return { kind: 'waiting', code, request };
}

function describe(answer: Answer): string {
    return `${String(answer.status)}${answer.code === null ? '' : ` ${answer.code}`}`;
}

/** Expects the options step to refuse `token` with `status` and `code`. */
async function refused(engine: JoinableEngine, token: string, status: number, code: string): Promise<Outcome> {
    const answer = await call(engine, 'POST', JOIN_OPTIONS_PATH, { ticket: token });
    return answer.status === status && answer.code === code
        ? { kind: 'pass' }
        : { kind: 'fail', detail: `expected ${String(status)} ${code}, got ${describe(answer)}` };
}

const timeoutMs: NonNullable<PlatformCheck['timeoutMs']> = (expectations) =>
    expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs * (BEATS_TO_ACK + 2);

/** `against` runs the rule on a given engine, so a test can prove each check fails an engine that breaks it. */
export interface JoinCheck extends PlatformCheck {
    against(engine: JoinableEngine): Promise<Outcome>;
}

function check(
    id: string,
    title: string,
    run: (engine: JoinableEngine) => Promise<Outcome>,
    timeout: NonNullable<PlatformCheck['timeoutMs']> = timeoutMs,
): JoinCheck {
    return {
        against: run,
        id: `member-access.${id}`,
        suite: SUITE,
        title,
        timeoutMs: timeout,
        async run(ctx) {
            const opened = await openJoinable(ctx);
            return opened.kind === 'done' ? opened.outcome : run(opened.engine);
        },
    };
}

const forger = async (): Promise<Signer> => createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));

export const forgedTicketRefused = check(
    'ticket.forged-refused',
    'A ticket signed by any key but the pinned member key is refused as ticket-invalid',
    async (engine) => refused(engine, await ticket(engine, {}, await forger()), 403, JOIN_PROBLEM.ticketInvalid),
);

export const otherEngineTicketRefused = check(
    'ticket.other-engine-refused',
    'A ticket for another engine is refused as ticket-invalid, so one engine’s ticket cannot open another',
    async (engine) => {
        const other = (engine.engineId.startsWith('a') ? 'b' : 'a').repeat(26) as EngineId;
        return refused(engine, await ticket(engine, { engineId: other }), 403, JOIN_PROBLEM.ticketInvalid);
    },
);

export const expiredTicketRefused = check(
    'ticket.expired-refused',
    'An expired ticket is refused as ticket-expired',
    async (engine) => {
        const iso = (ms: number) => Timestamp.parse(new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));
        const issuedAt = Date.now() - 20 * 60_000;
        const token = await ticket(engine, { issuedAt: iso(issuedAt), expiresAt: iso(issuedAt + 5 * 60_000) });
        return refused(engine, token, 403, JOIN_PROBLEM.ticketExpired);
    },
);

export const replayedTicketRefused = check(
    'ticket.replay-refused',
    'A ticket that made a request is refused as ticket-used when it comes again',
    async (engine) => {
        const token = await ticket(engine);
        const first = await join(engine, token);
        if (first.kind !== 'waiting') return { kind: 'fail', detail: `the join failed: ${describe(first.answer)}` };
        if (!/^\d{6}$/.test(first.code)) return { kind: 'fail', detail: 'the join code is not 6 digits' };
        return refused(engine, token, 409, JOIN_PROBLEM.ticketUsed);
    },
);

export const pendingCapEnforced = check(
    'ticket.pending-cap',
    `Past ${String(MAX_PENDING_ACCESS_REQUESTS)} pending requests a new ticket is refused as too-many-requests`,
    async (engine) => {
        for (let index = 0; index < MAX_PENDING_ACCESS_REQUESTS; index++) {
            const joined = await join(engine, await ticket(engine));
            if (joined.kind !== 'waiting') {
                return { kind: 'fail', detail: `request ${String(index + 1)} failed: ${describe(joined.answer)}` };
            }
        }
        return refused(engine, await ticket(engine), 409, JOIN_PROBLEM.tooManyRequests);
    },
);

export const spentTicketSurvivesRestart = check(
    'ticket.spent-across-restart',
    'A ticket that made a request is still refused as ticket-used after the engine restarts',
    async (engine) => {
        const token = await ticket(engine);
        const first = await join(engine, token);
        if (first.kind !== 'waiting') return { kind: 'fail', detail: `the join failed: ${describe(first.answer)}` };
        await engine.registered.restart();
        // The engine is back once it beat; its tunnel through the relay may take a moment longer.
        const deadline = Date.now() + engine.ctx.expectations.startTimeoutMs;
        let answer: Answer | null = null;
        while (answer === null || (answer.status >= 500 && Date.now() < deadline)) {
            if (answer !== null) await quietly(RETRY_MS, engine.ctx.signal);
            answer = await call(engine, 'POST', JOIN_OPTIONS_PATH, { ticket: token }).catch((): Answer => ({
                status: 599,
                code: null,
                body: null,
            }));
        }
        return answer.status === 409 && answer.code === JOIN_PROBLEM.ticketUsed
            ? { kind: 'pass' }
            : {
                  kind: 'fail',
                  detail: `after the restart the ticket answered ${describe(answer)}, not 409 ticket-used`,
              };
    },
    (expectations) => timeoutMs(expectations) + expectations.startTimeoutMs * 2,
);

/** The owner's session, or why the check cannot go on without one. */
async function ownerSession(engine: JoinableEngine): Promise<SessionCredential | Outcome> {
    const target = engine.ctx.engineTarget(engine.registered.engine, engine.endpoint);
    const session = (await target?.session({ kind: 'owner' })) ?? null;
    return session ?? { kind: 'skip', reason: 'no owner session for this engine (ENG-99)' };
}

const isOutcome = (value: SessionCredential | Outcome): value is Outcome => 'kind' in value;

async function pendingRequestId(engine: JoinableEngine, owner: SessionCredential): Promise<string | null> {
    const list = await call(engine, 'GET', `${ENGINE_API_PREFIX}/access-requests`, undefined, owner);
    const items = list.body?.['items'];
    if (!Array.isArray(items)) return null;
    const [first] = items as { readonly id?: unknown }[];
    return typeof first?.id === 'string' ? first.id : null;
}

async function approve(engine: JoinableEngine, owner: SessionCredential, code: string, role: string) {
    const id = await pendingRequestId(engine, owner);
    if (id === null) return null;
    return call(engine, 'POST', `${ENGINE_API_PREFIX}/access-requests/${id}/approve`, { code, role }, owner);
}

export const wrongCodeRefused = check(
    'approve.wrong-code',
    'Approving with a code other than the one shown is 422 access-code-mismatch; the right code signs the person in',
    async (engine) => {
        const owner = await ownerSession(engine);
        if (isOutcome(owner)) return owner;
        const joined = await join(engine, await ticket(engine));
        if (joined.kind !== 'waiting') return { kind: 'fail', detail: `the join failed: ${describe(joined.answer)}` };
        const wrong = joined.code === '000000' ? '000001' : '000000';
        const refusedAnswer = await approve(engine, owner, wrong, 'member');
        if (refusedAnswer?.status !== 422 || refusedAnswer.code !== 'access-code-mismatch') {
            return {
                kind: 'fail',
                detail: `a wrong code answered ${refusedAnswer === null ? 'no request' : describe(refusedAnswer)}`,
            };
        }
        const approved = await approve(engine, owner, joined.code, 'member');
        if (approved?.status !== 201) {
            return {
                kind: 'fail',
                detail: `the right code answered ${approved === null ? 'no request' : describe(approved)}`,
            };
        }
        const status = await call(engine, 'POST', JOIN_STATUS_PATH, { request: joined.request });
        return status.status === 200 && status.body?.['state'] === 'approved'
            ? { kind: 'pass' }
            : { kind: 'fail', detail: `the waiting page's status answered ${describe(status)}` };
    },
);

export const codeAttemptCap = check(
    'approve.attempt-cap',
    `The ${String(MAX_ACCESS_CODE_ATTEMPTS)}th wrong code deletes the request: the right code then finds nothing and the page says declined`,
    async (engine) => {
        const owner = await ownerSession(engine);
        if (isOutcome(owner)) return owner;
        const joined = await join(engine, await ticket(engine));
        if (joined.kind !== 'waiting') return { kind: 'fail', detail: `the join failed: ${describe(joined.answer)}` };
        const id = await pendingRequestId(engine, owner);
        if (id === null) return { kind: 'fail', detail: 'the request is not listed' };
        const attempt = (code: string) =>
            call(engine, 'POST', `${ENGINE_API_PREFIX}/access-requests/${id}/approve`, { code, role: 'member' }, owner);
        const wrong = joined.code === '000000' ? '000001' : '000000';
        for (let index = 1; index <= MAX_ACCESS_CODE_ATTEMPTS; index++) {
            const answer = await attempt(wrong);
            if (answer.status !== 422 || answer.code !== 'access-code-mismatch') {
                return { kind: 'fail', detail: `wrong code ${String(index)} answered ${describe(answer)}` };
            }
        }
        const right = await attempt(joined.code);
        if (right.status !== 404) {
            return {
                kind: 'fail',
                detail: `the right code after ${String(MAX_ACCESS_CODE_ATTEMPTS)} wrong ones answered ${describe(right)}`,
            };
        }
        const status = await call(engine, 'POST', JOIN_STATUS_PATH, { request: joined.request });
        return status.status === 200 && status.body?.['state'] === 'declined'
            ? { kind: 'pass' }
            : { kind: 'fail', detail: `the waiting page's status answered ${describe(status)}, not declined` };
    },
);

function acksOf(engine: JoinableEngine, since: number): HeartbeatV2['acks'] {
    return engine.registered.dashboard.heartbeats
        .filter((beat) => beat.at >= since)
        .flatMap((beat) =>
            beat.verification?.kind === 'accepted' && beat.verification.heartbeat.v === 2
                ? beat.verification.heartbeat.acks
                : [],
        );
}

/** Joins a person as `role`, approves them, then revokes them from the dashboard and returns the ack's outcome. */
async function revokeJoined(
    engine: JoinableEngine,
    owner: SessionCredential,
    role: string,
    beforeRevoking: (dashboardUserId: string) => Promise<Outcome | null> = () => Promise.resolve(null),
    issuedAtMs: number = Date.now(),
): Promise<
    { readonly kind: 'acked'; readonly outcome: string } | { readonly kind: 'done'; readonly outcome: Outcome }
> {
    const dashboardUserId = `conformance-${randomId(engine.ctx)}`;
    const joined = await join(engine, await ticket(engine, { dashboardUserId }));
    if (joined.kind !== 'waiting') {
        return { kind: 'done', outcome: { kind: 'fail', detail: `the join failed: ${describe(joined.answer)}` } };
    }
    const approved = await approve(engine, owner, joined.code, role);
    if (approved?.status !== 201) {
        return { kind: 'done', outcome: { kind: 'fail', detail: 'approving the request failed' } };
    }
    const early = await beforeRevoking(dashboardUserId);
    if (early !== null) return { kind: 'done', outcome: early };
    const id = randomId(engine.ctx);
    const token = await signMemberRevocation(engine.registered.dashboard.memberSigner, {
        v: 1,
        engineId: engine.engineId,
        revocationId: id,
        dashboardUserId,
        issuedAt: Timestamp.parse(new Date(issuedAtMs).toISOString().replace(/\.\d{3}Z$/, 'Z')),
    });
    const since = Date.now();
    engine.registered.dashboard.queueRevocation(engine.engineId, id, token);
    const ack = await attemptWait(
        engine.ctx,
        engine.registered,
        'ack the revocation',
        () => acksOf(engine, since).find((candidate) => candidate.id === id),
        engine.ctx.expectations.heartbeatIntervalMs * (BEATS_TO_ACK + 1),
    );
    if (!ack.ok) return { kind: 'done', outcome: { kind: 'fail', detail: ack.reason } };
    return { kind: 'acked', outcome: ack.value.outcome };
}

function expectAck(result: Awaited<ReturnType<typeof revokeJoined>>, expected: string): Outcome {
    if (result.kind === 'done') return result.outcome;
    return result.outcome === expected
        ? { kind: 'pass' }
        : { kind: 'fail', detail: `the ack says ${result.outcome}, not ${expected}` };
}

export const revocationRevokes = check(
    'revocation.revokes-member',
    'A signed revocation disables the member who joined with that dashboard user and is acked revoked',
    async (engine) => {
        const owner = await ownerSession(engine);
        if (isOutcome(owner)) return owner;
        return expectAck(await revokeJoined(engine, owner, 'member'), 'revoked');
    },
);

export const lastOwnerRefused = check(
    'revocation.last-owner-refused',
    'A revocation of the engine’s last owner is refused and acked refused-owner',
    async (engine) => {
        const owner = await ownerSession(engine);
        if (isOutcome(owner)) return owner;
        const me = await call(engine, 'GET', `${ENGINE_API_PREFIX}/me`, undefined, owner);
        const originalId = me.body?.['memberId'];
        if (typeof originalId !== 'string') return { kind: 'fail', detail: `GET /me answered ${describe(me)}` };
        const result = await revokeJoined(engine, owner, 'owner', async () => {
            // The joined owner is left as the only one: the original owner steps down to admin.
            const demoted = await call(
                engine,
                'PATCH',
                `${ENGINE_API_PREFIX}/members/${originalId}`,
                { role: 'admin' },
                owner,
            );
            return demoted.status === 200
                ? null
                : { kind: 'skip', reason: `the original owner could not step down: ${describe(demoted)}` };
        });
        return expectAck(result, 'refused-owner');
    },
);

export const switchedOffRefused = check(
    'revocation.switched-off',
    'With dashboard removals switched off, a revocation is refused and acked refused-disabled',
    async (engine) => {
        const owner = await ownerSession(engine);
        if (isOutcome(owner)) return owner;
        const off = await call(
            engine,
            'PUT',
            `${ENGINE_API_PREFIX}/settings/dashboard-removals`,
            { enabled: false },
            owner,
        );
        if (off.status !== 200) return { kind: 'fail', detail: `switching removals off answered ${describe(off)}` };
        return expectAck(await revokeJoined(engine, owner, 'member'), 'refused-disabled');
    },
);

export const staleRevocationIgnored = check(
    'revocation.stale-ignored',
    'A revocation issued well before the person joined is acked not-found and leaves them a member',
    async (engine) => {
        const owner = await ownerSession(engine);
        if (isOutcome(owner)) return owner;
        let target = '';
        const result = await revokeJoined(
            engine,
            owner,
            'member',
            (dashboardUserId) => {
                target = dashboardUserId;
                return Promise.resolve(null);
            },
            Date.now() - STALE_REVOCATION_MS,
        );
        const acked = expectAck(result, 'not-found');
        if (acked.kind !== 'pass') return acked;
        const members = await call(engine, 'GET', `${ENGINE_API_PREFIX}/members?limit=100`, undefined, owner);
        const items = Array.isArray(members.body?.['items'])
            ? (members.body['items'] as Record<string, unknown>[])
            : [];
        const member = items.find((item) => item['dashboardUserId'] === target);
        const status = member?.['status'];
        return status === 'active'
            ? { kind: 'pass' }
            : {
                  kind: 'fail',
                  detail: `the member is ${typeof status === 'string' ? status : 'not listed'} after the stale revocation`,
              };
    },
);

/**
 * The join page's checks (ADR 0018), driven through the gateway's join endpoints with a software authenticator. A
 * missing step-up on approval is not checked here: the harness's sessions always come with a fresh assertion.
 */
export const JOIN_CHECKS: readonly PlatformCheck[] = [
    forgedTicketRefused,
    otherEngineTicketRefused,
    expiredTicketRefused,
    replayedTicketRefused,
    spentTicketSurvivesRestart,
    pendingCapEnforced,
    wrongCodeRefused,
    codeAttemptCap,
    revocationRevokes,
    staleRevocationIgnored,
    lastOwnerRefused,
    switchedOffRefused,
];
