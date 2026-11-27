import { ENGINE_API_PREFIX } from '@ptbk/engine-api';
import type { OwnerSetupSecret } from '@ptbk/protocol';
import { newOwnerSetupSecret, ownerSetupCommitment } from '@ptbk/protocol';

import { createPasskey } from '../../fakes/authenticator';
import type { ReceivedHeartbeat, RegisteredEngine } from '../../fakes/dashboard';
import { startRegisteredEngine } from '../../fakes/dashboard';
import type { EngineApiEndpoint, PlatformCheck, PlatformCheckContext } from '../../harness/platform';
import { startTunnelRelay } from '../../tunnel/tunnel-relay';
import { attemptWait, quietly } from '../support';

export const SUITE = 'owner-handoff';
/**
 * How soon after its address serves `/setup` the engine must signal: it sends a heartbeat as soon as the signal turns
 * on, so the pairing tab redirects within seconds rather than a heartbeat interval later (ADR 0023).
 */
export const SIGNAL_MAX_DELAY_MS = 10_000;
/** The audit `details` that mark the owner's first passkey as registered through the handoff slot. */
export const HANDOFF_AUDIT_DETAILS = { via: 'owner-handoff' } as const;

const SETUP_PATH = '/setup';
const SETUP_OPTIONS_PATH = '/setup/options';
const SETUP_VERIFY_PATH = '/setup/verify';
const RETRY_MS = 250;

type Outcome = Awaited<ReturnType<PlatformCheck['run']>>;

interface Answer {
    readonly status: number;
    readonly code: string | null;
    readonly body: Record<string, unknown> | null;
    readonly cookie: string | null;
}

/** An engine registered with a commitment to `secret`, reachable through a fake relay, that signalled the handoff. */
export interface HandoffEngine {
    readonly registered: RegisteredEngine;
    readonly endpoint: EngineApiEndpoint;
    readonly secret: OwnerSetupSecret;
    readonly ctx: PlatformCheckContext;
    /** When `/setup` first answered 200 through the relay. */
    readonly servedAt: number;
    /** The first heartbeat that carried `ownerHandoff: "ready"`. */
    readonly ready: ReceivedHeartbeat;
}

type Opened =
    { readonly kind: 'ok'; readonly engine: HandoffEngine } | { readonly kind: 'done'; readonly outcome: Outcome };

function handoffOf(beat: ReceivedHeartbeat): string | undefined {
    return beat.verification?.kind === 'accepted' ? beat.verification.heartbeat.ownerHandoff : undefined;
}

function acceptedSince(registered: RegisteredEngine, since: number): readonly ReceivedHeartbeat[] {
    return registered.dashboard.heartbeats.filter(
        (beat) => beat.at >= since && beat.verification?.kind === 'accepted' && beat.answer.status < 300,
    );
}

/** A same-origin request, as the setup page sends it; any network failure reads as status 599. */
async function call(
    endpoint: EngineApiEndpoint,
    signal: AbortSignal,
    method: string,
    path: string,
    body?: unknown,
    cookie?: string,
): Promise<Answer> {
    const headers: Record<string, string> = {
        Origin: endpoint.baseUrl.origin,
        'Sec-Fetch-Site': 'same-origin',
        Accept: 'application/json, application/problem+json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie !== undefined) headers['Cookie'] = cookie;
    try {
        const response = await endpoint.fetch(new URL(path, endpoint.baseUrl), {
            method,
            headers,
            redirect: 'manual',
            signal,
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
    } catch {
        return { status: 599, code: null, body: null, cookie: null };
    }
}

function describe(answer: Answer): string {
    return `${String(answer.status)}${answer.code === null ? '' : ` ${answer.code}`}`;
}

/** When `/setup` first answers 200 through the relay, or null if it does not within the start timeout. */
async function setupServed(ctx: PlatformCheckContext, endpoint: EngineApiEndpoint): Promise<number | null> {
    const deadline = Date.now() + ctx.expectations.startTimeoutMs;
    while (Date.now() < deadline && !ctx.signal.aborted) {
        const answer = await call(endpoint, ctx.signal, 'GET', SETUP_PATH);
        if (answer.status === 200) return Date.now();
        await quietly(RETRY_MS, ctx.signal);
    }
    return null;
}

interface Started {
    readonly registered: RegisteredEngine;
    readonly endpoint: EngineApiEndpoint;
    readonly servedAt: number;
}

async function startServing(
    ctx: PlatformCheckContext,
    secret: OwnerSetupSecret | null,
): Promise<Started | { readonly kind: 'done'; readonly outcome: Outcome }> {
    const relay = ctx.use(await startTunnelRelay(ctx, { relays: 1 }));
    const registered = await startRegisteredEngine(ctx, {
        env: relay.env,
        ...(secret === null ? {} : { ownerSetupCommitment: await ownerSetupCommitment(secret) }),
    });
    const endpoint = await relay.endpointFor(registered);
    const servedAt = await setupServed(ctx, endpoint);
    if (servedAt === null) {
        return { kind: 'done', outcome: { kind: 'fail', detail: 'GET /setup never answered 200 through the relay' } };
    }
    return { registered, endpoint, servedAt };
}

async function openHandoff(ctx: PlatformCheckContext): Promise<Opened> {
    const secret = newOwnerSetupSecret(ctx.random);
    const started = await startServing(ctx, secret);
    if ('kind' in started) return started;
    const { registered, endpoint, servedAt } = started;
    const ready = await attemptWait(
        ctx,
        registered,
        'send ownerHandoff ready',
        () => acceptedSince(registered, 0).find((beat) => handoffOf(beat) === 'ready'),
        SIGNAL_MAX_DELAY_MS + ctx.expectations.heartbeatIntervalMs * 2,
    );
    if (!ready.ok) {
        return {
            kind: 'done',
            outcome: {
                kind: 'skip',
                reason: 'no heartbeat carried ownerHandoff: the engine has no owner setup handoff, or runs with it off',
            },
        };
    }
    return { kind: 'ok', engine: { registered, endpoint, secret, ctx, servedAt, ready: ready.value } };
}

function options(engine: HandoffEngine, secret: string): Promise<Answer> {
    return call(engine.endpoint, engine.ctx.signal, 'POST', SETUP_OPTIONS_PATH, { secret });
}

/** The setup page's whole flow with the handoff secret: options, a software passkey, verify. */
async function setUpOwner(engine: HandoffEngine): Promise<Answer> {
    const offered = await options(engine, engine.secret);
    if (offered.status !== 200) return offered;
    const response = await createPasskey(offered.body?.['options'], engine.endpoint.baseUrl.origin);
    return call(engine.endpoint, engine.ctx.signal, 'POST', SETUP_VERIFY_PATH, { secret: engine.secret, response });
}

/** How many heartbeats the dashboard has received so far, to watch only those that come later. */
function beatsSoFar(engine: HandoffEngine): number {
    return engine.registered.dashboard.heartbeats.length;
}

/**
 * Waits for two accepted heartbeats after the first `seen` and fails if the second still signals: the first may have
 * left before the engine saw the change.
 */
async function signalEnded(engine: HandoffEngine, seen: number, after: string): Promise<Outcome> {
    const { ctx, registered } = engine;
    const later = (): readonly ReceivedHeartbeat[] =>
        registered.dashboard.heartbeats
            .slice(seen)
            .filter((beat) => beat.verification?.kind === 'accepted' && beat.answer.status < 300);
    const second = await attemptWait(
        ctx,
        registered,
        `send two heartbeats ${after}`,
        () => later()[1],
        ctx.expectations.heartbeatIntervalMs * 3,
    );
    if (!second.ok) return { kind: 'fail', detail: second.reason };
    return handoffOf(second.value) === undefined
        ? { kind: 'pass' }
        : { kind: 'fail', detail: `heartbeats ${after} still carry ownerHandoff` };
}

const timeoutMs: NonNullable<PlatformCheck['timeoutMs']> = (expectations) =>
    expectations.startTimeoutMs * 3 + SIGNAL_MAX_DELAY_MS + expectations.heartbeatIntervalMs * 6;

/** `against` runs the rule on a given engine, so a test can prove each check fails an engine that breaks it. */
export interface HandoffCheck extends PlatformCheck {
    against(engine: HandoffEngine): Promise<Outcome>;
}

function check(id: string, title: string, run: (engine: HandoffEngine) => Promise<Outcome>): HandoffCheck {
    return {
        against: run,
        id: `${SUITE}.${id}`,
        suite: SUITE,
        title,
        timeoutMs,
        async run(ctx) {
            const opened = await openHandoff(ctx);
            return opened.kind === 'done' ? opened.outcome : run(opened.engine);
        },
    };
}

export const signalPrompt = check(
    'signal.prompt',
    `ownerHandoff "ready" arrives within ${String(SIGNAL_MAX_DELAY_MS / 1000)} s of /setup being served, not a heartbeat interval later`,
    (engine) => {
        const delay = engine.ready.at - engine.servedAt;
        return Promise.resolve(
            delay <= SIGNAL_MAX_DELAY_MS
                ? { kind: 'pass' }
                : { kind: 'fail', detail: `the signal came ${String(delay)} ms after /setup was served` },
        );
    },
);

export const secretAccepted = check(
    'setup.secret-accepted',
    'The pairing tab’s secret opens /setup/options, while a wrong one and the commitment itself get setup-link-invalid',
    async (engine) => {
        const wrong = newOwnerSetupSecret(engine.ctx.random);
        const commitment = await ownerSetupCommitment(engine.secret);
        for (const [name, candidate] of [
            ['a wrong secret', wrong],
            ['the commitment instead of the secret', commitment],
        ] as const) {
            const answer = await options(engine, candidate);
            if (answer.status !== 403 || answer.code !== 'setup-link-invalid') {
                return { kind: 'fail', detail: `${name}: expected 403 setup-link-invalid, got ${describe(answer)}` };
            }
        }
        const answer = await options(engine, engine.secret);
        return answer.status === 200 && typeof answer.body?.['options'] === 'object'
            ? { kind: 'pass' }
            : { kind: 'fail', detail: `the handoff secret: expected 200 with options, got ${describe(answer)}` };
    },
);

export const ownerSpendsBoth = check(
    'setup.owner-spends-slot',
    'The first owner passkey spends the handoff secret and ends the signal, also after a restart',
    async (engine) => {
        const verified = await setUpOwner(engine);
        if (verified.status !== 200) return { kind: 'fail', detail: `setup with the secret: ${describe(verified)}` };
        const setUp = beatsSoFar(engine);
        const again = await options(engine, engine.secret);
        if (again.status !== 409 || again.code !== 'owner-exists') {
            return {
                kind: 'fail',
                detail: `the secret after setup: expected 409 owner-exists, got ${describe(again)}`,
            };
        }
        const ended = await signalEnded(engine, setUp, 'after setup');
        if (ended.kind !== 'pass') return ended;
        const beforeRestart = beatsSoFar(engine);
        await engine.registered.restart();
        return signalEnded(engine, beforeRestart, 'after a restart with an owner');
    },
);

interface AuditPage {
    readonly items?: readonly { readonly action?: unknown; readonly details?: unknown }[];
}

export const setupAudited = check(
    'setup.audited',
    `The owner's first passkey through the handoff is audited as passkey.register with details ${JSON.stringify(HANDOFF_AUDIT_DETAILS)}`,
    async (engine) => {
        const verified = await setUpOwner(engine);
        if (verified.status !== 200 || verified.cookie === null) {
            return { kind: 'fail', detail: `setup with the secret gave no session: ${describe(verified)}` };
        }
        const audit = await call(
            engine.endpoint,
            engine.ctx.signal,
            'GET',
            `${ENGINE_API_PREFIX}/audit`,
            undefined,
            verified.cookie,
        );
        if (audit.status !== 200) return { kind: 'fail', detail: `GET /audit as the new owner: ${describe(audit)}` };
        const items = (audit.body as AuditPage | null)?.items ?? [];
        const marked = items.some((item) => {
            if (item.action !== 'passkey.register') return false;
            const details = item.details as Record<string, unknown> | null | undefined;
            return details?.['via'] === HANDOFF_AUDIT_DETAILS.via;
        });
        return marked
            ? { kind: 'pass' }
            : { kind: 'fail', detail: 'no passkey.register entry is marked as the handoff' };
    },
);

/** For a test: the engine registered without a commitment, after `/setup` was served. */
export interface UncommittedEngine {
    readonly registered: RegisteredEngine;
    readonly servedAt: number;
    readonly ctx: PlatformCheckContext;
}

/** Engines without handoff pass too: they never signal anything. */
export async function signalAbsentAgainst(engine: UncommittedEngine): Promise<Outcome> {
    const { ctx, registered } = engine;
    const watched = await attemptWait(
        ctx,
        registered,
        'send two heartbeats after /setup was served',
        () => (acceptedSince(registered, engine.servedAt).length >= 2 ? true : undefined),
        SIGNAL_MAX_DELAY_MS + ctx.expectations.heartbeatIntervalMs * 3,
    );
    if (!watched.ok) return { kind: 'fail', detail: watched.reason };
    return acceptedSince(registered, 0).some((beat) => handoffOf(beat) !== undefined)
        ? { kind: 'fail', detail: 'an engine registered without a commitment sent ownerHandoff' }
        : { kind: 'pass' };
}

export const signalAbsentWithoutCommitment: PlatformCheck = {
    id: `${SUITE}.signal.absent-without-commitment`,
    suite: SUITE,
    title: 'An engine registered without a commitment (an older dashboard) never sends ownerHandoff',
    timeoutMs,
    async run(ctx) {
        const started = await startServing(ctx, null);
        if ('kind' in started) return started.outcome;
        return signalAbsentAgainst({ registered: started.registered, servedAt: started.servedAt, ctx });
    },
};

export const HANDOFF_CHECKS: readonly HandoffCheck[] = [signalPrompt, secretAccepted, ownerSpendsBoth, setupAudited];
