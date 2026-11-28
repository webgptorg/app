import { ENGINE_API_PREFIX, JOIN_STATUS_PATH, KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { EngineInfo, NotificationKind } from '@ptbk/engine-api';
import {
    ATTENTION_KINDS,
    MAX_HEARTBEAT_ATTENTION,
    MAX_HEARTBEAT_COUNT,
    Timestamp,
    encodeBase64Url,
    signMemberRevocation,
} from '@ptbk/protocol';

import type { SessionCredential } from '../../../src/index';
import type { NotificationsTarget } from '../../../src/target';
import type { PlatformCheck, PlatformCheckContext } from '../../harness/platform';
import type { JoinableEngine, Outcome } from '../member-access/join';
import { approve, isOutcome, join, openJoinable, ownerSession, ticket } from '../member-access/join';
import { attemptWait } from '../support';

export const SUITE = 'notifications';
/** One beat may have left before the engine saw a change, so a check judges the second one after it. */
const BEATS_TO_SETTLE = 2;
const ENTRY_KEYS: ReadonlySet<string> = new Set(['to', 'kind', 'count']);
const KINDS: ReadonlySet<string> = new Set(ATTENTION_KINDS);

/** One heartbeat, as the bytes arrived. */
export interface Beat {
    readonly at: number;
    readonly text: string;
}

export interface Answer {
    readonly status: number;
    readonly code: string | null;
    readonly body: Record<string, unknown> | null;
    /** `name=value` of the first `Set-Cookie`, if any. */
    readonly cookie: string | null;
}

/** A person who joined with a dashboard ticket and was approved. */
export interface Admitted {
    readonly memberId: string;
    readonly dashboardUserId: string;
    /** Their own session, from the join page's status once approved; `null` when the engine set none. */
    readonly session: SessionCredential | null;
}

/** What the checks need from an engine; `openAttentionEngine` builds it, tests script it. */
export interface AttentionEngine {
    readonly owner: SessionCredential;
    readonly notifications: NotificationsTarget;
    /**
     * Every heartbeat received at or after `since`, oldest first, whether the dashboard accepted it or not: a body that
     * leaks content breaks the strict schema and is refused, and must still be judged.
     */
    sent(since: number): readonly Beat[];
    /** Waits for the `count`th accepted heartbeat at or after `since`; a string says why it never came. */
    awaitBeat(since: number, count: number): Promise<Beat | string>;
    api(method: string, path: string, body?: unknown, session?: SessionCredential): Promise<Answer>;
    /** Issues a ticket, joins with it and has the owner approve it; a string says what failed. */
    admit(): Promise<Admitted | string>;
    /** The dashboard revokes the person through the heartbeat reply, as when they leave the team. */
    revoke(dashboardUserId: string): Promise<void>;
}

type Opened =
    { readonly kind: 'ok'; readonly engine: AttentionEngine } | { readonly kind: 'done'; readonly outcome: Outcome };

function sentSince(joinable: JoinableEngine, since: number): readonly Beat[] {
    return joinable.registered.dashboard.heartbeats
        .filter((beat) => beat.at >= since)
        .map((beat) => ({ at: beat.at, text: beat.rawBody.toString('utf8') }));
}

function acceptedSince(joinable: JoinableEngine, since: number): readonly Beat[] {
    return joinable.registered.dashboard.heartbeats
        .filter(
            (beat) =>
                beat.at >= since &&
                beat.verification?.kind === 'accepted' &&
                beat.verification.heartbeat.v === 2 &&
                beat.answer.status < 300,
        )
        .map((beat) => ({ at: beat.at, text: beat.rawBody.toString('utf8') }));
}

async function call(
    joinable: JoinableEngine,
    method: string,
    path: string,
    body?: unknown,
    session?: SessionCredential,
): Promise<Answer> {
    const { endpoint, ctx } = joinable;
    const headers: Record<string, string> = {
        Origin: endpoint.baseUrl.origin,
        'Sec-Fetch-Site': 'same-origin',
        Accept: 'application/json, application/problem+json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session !== undefined) {
        if ('cookie' in session) headers['Cookie'] = session.cookie;
        else headers['Authorization'] = `Bearer ${session.bearer}`;
    }
    const response = await endpoint.fetch(new URL(path, endpoint.baseUrl), {
        method,
        headers,
        redirect: 'manual',
        signal: ctx.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed: unknown = await response.json().catch(() => null);
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    const setCookie = response.headers.get('set-cookie');
    return {
        status: response.status,
        code: typeof record?.['code'] === 'string' ? record['code'] : null,
        body: record,
        cookie: setCookie === null ? null : (setCookie.split(';')[0] ?? null),
    };
}

/** The checks' view of a real engine behind the harness; exported for its own tests. */
export function attentionEngine(
    joinable: JoinableEngine,
    owner: SessionCredential,
    notifications: NotificationsTarget,
): AttentionEngine {
    const { ctx, registered } = joinable;
    const randomId = () => encodeBase64Url(ctx.random.bytes(16));
    return {
        owner,
        notifications,
        sent: (since) => sentSince(joinable, since),
        async awaitBeat(since, count) {
            const beat = await attemptWait(
                ctx,
                registered,
                `send ${String(count)} heartbeats`,
                () => acceptedSince(joinable, since)[count - 1],
                ctx.expectations.heartbeatIntervalMs * (count + 1),
            );
            return beat.ok ? beat.value : beat.reason;
        },
        api: (method, path, body, session) => call(joinable, method, path, body, session),
        async admit() {
            const dashboardUserId = `conformance-${randomId()}`;
            const joined = await join(joinable, await ticket(joinable, { dashboardUserId }));
            if (joined.kind !== 'waiting') return `the join failed at ${joined.step}`;
            const approved = await approve(joinable, owner, joined.code, 'member');
            const memberId = approved?.body?.['id'];
            if (approved?.status !== 201 || typeof memberId !== 'string') return 'approving the request failed';
            const status = await call(joinable, 'POST', JOIN_STATUS_PATH, { request: joined.request });
            return { memberId, dashboardUserId, session: status.cookie === null ? null : { cookie: status.cookie } };
        },
        async revoke(dashboardUserId) {
            const id = randomId();
            const token = await signMemberRevocation(registered.dashboard.memberSigner, {
                v: 1,
                engineId: joinable.engineId,
                revocationId: id,
                dashboardUserId,
                issuedAt: Timestamp.parse(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')),
            });
            registered.dashboard.queueRevocation(joinable.engineId, id, token);
        },
    };
}

async function openAttentionEngine(ctx: PlatformCheckContext): Promise<Opened> {
    const opened = await openJoinable(ctx);
    if (opened.kind === 'done') return opened;
    const joinable = opened.engine;
    const owner = await ownerSession(joinable);
    if (isOutcome(owner)) return { kind: 'done', outcome: owner };
    const info = await call(joinable, 'GET', `${ENGINE_API_PREFIX}/engine`, undefined, owner);
    if (info.status !== 200 || !supports(info.body as unknown as EngineInfo, KNOWN_CAPABILITIES.notifications)) {
        return { kind: 'done', outcome: { kind: 'skip', reason: 'capability-not-advertised' } };
    }
    const notifications = ctx.engineTarget(joinable.registered.engine, joinable.endpoint)?.notifications;
    if (notifications === undefined) {
        return { kind: 'done', outcome: { kind: 'skip', reason: 'the target cannot raise notifications' } };
    }
    return { kind: 'ok', engine: attentionEngine(joinable, owner, notifications) };
}

interface Entry {
    readonly to?: unknown;
    readonly kind?: unknown;
    readonly count?: unknown;
}

/** The body's `attention` as sent: `undefined` when absent, anything else as found. */
function attentionOf(beat: Beat): unknown {
    let body: unknown;
    try {
        body = JSON.parse(beat.text);
    } catch {
        return undefined;
    }
    return typeof body === 'object' && body !== null && 'attention' in body ? body.attention : undefined;
}

/**
 * Everything ADR 0027 promises about one body: entries of only `to`, `kind` and `count`, known kinds, counts and
 * length within the caps, one entry per person and kind, `to` only among `allowed`, and none of `secrets` anywhere.
 */
function judgeBeat(beat: Beat, allowed: ReadonlySet<string>, secrets: readonly string[]): string[] {
    const problems: string[] = [];
    for (const secret of secrets) {
        if (beat.text.includes(secret)) problems.push(`the heartbeat body carries engine content (${secret})`);
    }
    const attention = attentionOf(beat);
    if (attention === undefined) return problems;
    if (!Array.isArray(attention)) return [...problems, 'attention is not a list'];
    if (attention.length > MAX_HEARTBEAT_ATTENTION) problems.push(`attention has ${String(attention.length)} entries`);
    const keys = new Set<string>();
    for (const entry of attention as Entry[]) {
        const extra = Object.keys(entry).filter((key) => !ENTRY_KEYS.has(key));
        if (extra.length > 0) problems.push(`an attention entry carries ${extra.join(', ')}`);
        if (typeof entry.kind !== 'string' || !KINDS.has(entry.kind))
            problems.push('an attention entry has an unknown kind');
        if (typeof entry.count !== 'number' || entry.count < 1 || entry.count > MAX_HEARTBEAT_COUNT) {
            problems.push('an attention count is outside 1..MAX_HEARTBEAT_COUNT');
        }
        const to = entry.to === undefined ? undefined : JSON.stringify(entry.to);
        if (to !== undefined && (typeof entry.to !== 'string' || !allowed.has(entry.to))) {
            problems.push(`attention names ${to}, who has no approved ticket on this engine`);
        }
        const key = `${to ?? ''} ${JSON.stringify(entry.kind)}`;
        if (keys.has(key)) problems.push('attention has two entries for one person and kind');
        keys.add(key);
    }
    return problems;
}

function countFor(beat: Beat, to: string | undefined, kind: NotificationKind): number {
    const attention = attentionOf(beat);
    if (!Array.isArray(attention)) return 0;
    const entry = (attention as Entry[]).find((candidate) => candidate.to === to && candidate.kind === kind);
    return typeof entry?.count === 'number' ? entry.count : 0;
}

function failing(problems: readonly string[]): Outcome {
    return { kind: 'fail', detail: [...new Set(problems)].join('; ') };
}

async function setSharing(engine: AttentionEngine, enabled: boolean): Promise<Outcome | null> {
    const answer = await engine.api(
        'PUT',
        `${ENGINE_API_PREFIX}/settings/dashboard-attention`,
        { enabled },
        engine.owner,
    );
    if (answer.status === 200) return null;
    if (answer.code === 'step-up-required') {
        return { kind: 'skip', reason: 'the engine wants a fresh passkey for the switch, which the suite cannot give' };
    }
    return { kind: 'fail', detail: `PUT /settings/dashboard-attention answered ${String(answer.status)}` };
}

async function ownMemberId(engine: AttentionEngine): Promise<string | null> {
    const me = await engine.api('GET', `${ENGINE_API_PREFIX}/me`, undefined, engine.owner);
    const id = me.body?.['memberId'];
    return typeof id === 'string' ? id : null;
}

const timeoutMs: NonNullable<PlatformCheck['timeoutMs']> = (expectations) =>
    expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs * (BEATS_TO_SETTLE * 3 + 4);

/** `against` runs the rule on a given engine, so a test can prove each check fails an engine that breaks it. */
export interface AttentionCheck extends PlatformCheck {
    against(engine: AttentionEngine): Promise<Outcome>;
}

function check(id: string, title: string, run: (engine: AttentionEngine) => Promise<Outcome>): AttentionCheck {
    return {
        against: run,
        id: `${SUITE}.${id}`,
        suite: SUITE,
        title,
        timeoutMs,
        async run(ctx) {
            const opened = await openAttentionEngine(ctx);
            return opened.kind === 'done' ? opened.outcome : run(opened.engine);
        },
    };
}

export const attentionRecipients = check(
    'attention.recipients',
    'attention counts unseen items only for people with an approved ticket and project-wide, carries no content, ' +
        'and drops a person once they saw their items or the dashboard revoked them',
    async (engine) => {
        const off = await setSharing(engine, true);
        if (off !== null) return off;
        const since = Date.now();
        const person = await engine.admit();
        const leaver = await engine.admit();
        if (typeof person === 'string') return { kind: 'fail', detail: person };
        if (typeof leaver === 'string') return { kind: 'fail', detail: leaver };
        const ownerId = await ownMemberId(engine);
        if (ownerId === null) return { kind: 'fail', detail: 'GET /me answered no memberId' };
        const titles = ['person', 'owner', 'project', 'leaver'].map((label) => `conformance-${label}-${String(since)}`);
        const [personTitle = '', ownerTitle = '', projectTitle = '', leaverTitle = ''] = titles;
        const raise = (memberId: string | null, kind: NotificationKind, title: string) =>
            engine.notifications.raise({ memberId, kind, title });
        const ids = [
            await raise(person.memberId, 'agent-waiting', personTitle),
            await raise(ownerId, 'task-failed', ownerTitle),
            await raise(null, 'tool-sign-in', projectTitle),
            await raise(leaver.memberId, 'task-failed', leaverTitle),
        ];
        // Short IDs could match a number in the body by chance; the titles alone prove no text leaks.
        const secrets = [...titles, ...ids, person.memberId, leaver.memberId, ownerId].filter(
            (value) => value.length >= 8,
        );
        const allowed = new Set([person.dashboardUserId, leaver.dashboardUserId]);
        const judged = () => engine.sent(since).flatMap((beat) => judgeBeat(beat, allowed, secrets));
        const raisedAt = Date.now();

        const shared = await engine.awaitBeat(raisedAt, BEATS_TO_SETTLE);
        if (typeof shared === 'string') return failing([...judged(), shared]);
        const problems: string[] = [];
        if (!Array.isArray(attentionOf(shared))) problems.push('switched on, the heartbeat carries no attention');
        if (countFor(shared, person.dashboardUserId, 'agent-waiting') !== 1) {
            problems.push('attention does not count the approved person’s one unseen item');
        }
        if (countFor(shared, undefined, 'tool-sign-in') < 1)
            problems.push('attention does not count project-wide items');

        await engine.revoke(leaver.dashboardUserId);
        if (person.session === null) return { kind: 'fail', detail: 'the approved person got no session' };
        const seen = await engine.api(
            'POST',
            `${ENGINE_API_PREFIX}/me/notifications/seen`,
            { ids: [ids[0]] },
            person.session,
        );
        if (seen.status !== 200) problems.push(`the person marking their item seen got ${String(seen.status)}`);
        const changedAt = Date.now();
        // The revocation leaves in one beat's reply and takes effect before a later one.
        const settled = await engine.awaitBeat(changedAt, BEATS_TO_SETTLE + 1);
        if (typeof settled === 'string') return failing([...problems, ...judged(), settled]);
        if (countFor(settled, person.dashboardUserId, 'agent-waiting') !== 0) {
            problems.push('attention still counts an item its person saw');
        }
        if (countFor(settled, leaver.dashboardUserId, 'task-failed') !== 0) {
            problems.push('attention still names a person the dashboard revoked');
        }
        problems.push(...judged());
        return problems.length === 0 ? { kind: 'pass' } : failing(problems);
    },
);

export const attentionSwitchedOff = check(
    'attention.switched-off',
    'Switched off by the owner, heartbeats leave attention out entirely, even while unseen items wait',
    async (engine) => {
        const before = await engine.api('GET', `${ENGINE_API_PREFIX}/settings`, undefined, engine.owner);
        const initial = before.body?.['dashboardAttention'];
        if (typeof initial !== 'boolean') return { kind: 'fail', detail: 'GET /settings has no dashboardAttention' };
        const off = await setSharing(engine, false);
        if (off !== null) return off;
        await engine.notifications.raise({ memberId: null, kind: 'tool-sign-in', title: 'conformance-switched-off' });
        const since = Date.now();
        const beat = await engine.awaitBeat(since, BEATS_TO_SETTLE);
        const restored = initial ? await setSharing(engine, true) : null;
        if (typeof beat === 'string') return { kind: 'fail', detail: beat };
        if (attentionOf(beat) !== undefined)
            return { kind: 'fail', detail: 'switched off, heartbeats still carry attention' };
        return restored ?? { kind: 'pass' };
    },
);

export const ATTENTION_CHECKS: readonly AttentionCheck[] = [attentionRecipients, attentionSwitchedOff];
