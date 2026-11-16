import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { z } from 'zod';

import type { ActiveSession } from '../../domain/auth/account';
import { SECRET_PATTERN } from '../../domain/auth/secrets';
import type { Authorizer, Resource } from '../../domain/authz/authorizer';
import { DASHBOARD_POLICY, type DashboardAction } from '../../domain/authz/policy';
import type { Logger } from '../../domain/ports/logger';
import type { RelayActor } from '../../domain/registry/authenticate-relay';
import { RATE_LIMITS, type RateLimiter, type RateLimitRuleName } from '../../domain/ports/rate-limiter';
import type {
    AuthMode,
    ParsedRouteInput,
    RouteContract,
    RouteErrorCode,
    RouteResponse,
} from '../../shared/api/contract';
import { RAW_BODY } from '../../shared/api/contract';
import type { CommonProblemCode } from '../../shared/api/problem';
import { clearSessionCookie, SESSION_COOKIE } from './cookies';
import { problemResponse, type ProblemExtensions, type ProblemStatus } from './problem';

export type RouteResult<C extends RouteContract> =
    | {
          readonly kind: 'ok';
          readonly body: RouteResponse<C>;
          /** 204 sends no body; only for routes whose output is `NO_CONTENT`. */
          readonly status?: 200 | 202 | 204;
          /** Serialized `Set-Cookie` values. */
          readonly setCookies?: readonly string[];
      }
    | {
          /** Only on `redirect` routes; `location` is built by the handler, never taken from input. */
          readonly kind: 'redirect';
          readonly location: string;
          readonly setCookies?: readonly string[];
      }
    | {
          readonly kind: 'problem';
          readonly status: ProblemStatus;
          readonly code: RouteErrorCode<C> | CommonProblemCode;
          readonly extensions?: ProblemExtensions;
          readonly setCookies?: readonly string[];
      };

/** What a handler may know about the request besides its validated input. */
export interface RequestContext {
    readonly signal: AbortSignal;
    /** A cookie value, only if it has the shape of one of our 256-bit secrets. */
    secretCookie(name: string): string | null;
    /** For locale negotiation only; never logged. */
    header(name: 'cookie' | 'accept-language'): string | null;
    /** Work that continues after the response, such as sending email (Workers `ctx.waitUntil`). */
    waitUntil(task: Promise<unknown>): void;
}

export interface RouteArgs<C extends RouteContract> {
    readonly input: ParsedRouteInput<C>;
    readonly request: RequestContext;
    /** Present exactly when the route's `auth` is `session`. */
    readonly session: C['auth'] extends 'session' ? ActiveSession : null;
    /** Present exactly when the route's `auth` is `relay-token`. */
    readonly relay: C['auth'] extends 'relay-token' ? RelayActor : null;
}

export type RouteHandler<C extends RouteContract> = (args: RouteArgs<C>) => Promise<RouteResult<C>>;

/** Modes whose signature arrives in a header and covers the raw body. */
export type SignatureMode = Exclude<AuthMode, 'public' | 'session' | 'engine-signature' | 'relay-token'>;

/** Checks a signature over the exact request bytes and only then reads them; `payload` is parsed by the contract. */
export type SignatureVerifier = (
    payload: Uint8Array,
    signature: string,
) => Promise<{ readonly kind: 'verified'; readonly payload: unknown } | { readonly kind: 'invalid' }>;

/** The header each signature mode reads. */
const SIGNATURE_HEADERS = { 'stripe-signature': 'stripe-signature' } as const satisfies Record<SignatureMode, string>;

export interface RouteBinderDeps {
    readonly authorizer: Authorizer<DashboardAction>;
    readonly rateLimiter: RateLimiter;
    readonly logger: Logger;
    resolveSession(token: string): Promise<ActiveSession | null>;
    /** The `Authorization` header as sent, or null; `defer` is the request's `waitUntil`. */
    authenticateRelay(
        authorization: string | null,
        defer: (task: Promise<unknown>) => void,
    ): Promise<RelayActor | null>;
    readonly signatures: Readonly<Record<SignatureMode, SignatureVerifier>>;
    /** The matched route's template per request, for the request metrics (never the raw path). */
    readonly routeTemplates: WeakMap<Request, string>;
}

export interface RouteBinder {
    /** The only way to mount a route: it refuses a contract without auth, permission or rate limit. */
    bind<C extends RouteContract>(router: Hono, mount: string, contract: C, handler: RouteHandler<C>): void;
    /** Every route mounted so far, for the route-table test. */
    readonly routes: readonly RouteContract[];
}

type ParseOutcome =
    | { readonly kind: 'ok'; readonly value: unknown }
    | { readonly kind: 'invalid' | 'too-large' }
    /** A signed route whose signature is missing or does not verify. */
    | { readonly kind: 'unsigned' };

function isSignatureMode(auth: AuthMode): auth is SignatureMode {
    return Object.hasOwn(SIGNATURE_HEADERS, auth);
}

function isPolicyAction(action: string): action is DashboardAction {
    return Object.hasOwn(DASHBOARD_POLICY, action);
}

export function isIpRateLimit(rule: string): rule is RateLimitRuleName {
    return Object.hasOwn(RATE_LIMITS, rule) && rule.endsWith('-ip');
}

export function isRelayRateLimit(rule: string): rule is RateLimitRuleName {
    return Object.hasOwn(RATE_LIMITS, rule) && rule.endsWith('-relay');
}

export function isEngineRateLimit(rule: string): rule is RateLimitRuleName {
    return Object.hasOwn(RATE_LIMITS, rule) && rule.endsWith('-engine');
}

/** Throws at mount time, so a route that skips a safeguard never serves a request. */
export function assertMountable(contract: RouteContract, mount: string): void {
    const problems: string[] = [];
    if (!contract.path.startsWith(`${mount}/`)) {
        problems.push(`path outside ${mount}`);
    }
    if (contract.auth === 'session' && (contract.permission === null || !isPolicyAction(contract.permission))) {
        problems.push('session route without a policy permission');
    }
    if (contract.auth === 'relay-token') {
        if (contract.rateLimit === null || !isRelayRateLimit(contract.rateLimit)) {
            problems.push('relay route without a per-relay rate limit');
        }
    } else if (contract.auth !== 'session' && (contract.rateLimit === null || !isIpRateLimit(contract.rateLimit))) {
        problems.push('non-session route without a per-IP rate limit');
    }
    if (contract.rateLimit !== null && !isIpRateLimit(contract.rateLimit) && !isRelayRateLimit(contract.rateLimit)) {
        problems.push('unknown rate limit');
    }
    if (
        contract.engineRateLimit !== undefined &&
        (!isEngineRateLimit(contract.engineRateLimit) || !contract.path.includes('/:engineId'))
    ) {
        problems.push('engine rate limit without an -engine rule and an :engineId parameter');
    }
    if (contract.input.body === RAW_BODY && contract.auth !== 'engine-signature') {
        problems.push('raw body outside an engine-signed route');
    }
    if ((contract.input.body === null) !== (contract.input.maxBodyBytes === 0)) {
        problems.push('body schema and size cap disagree');
    }
    if (contract.responseType === 'text' && contract.auth !== 'public') {
        problems.push('text response outside a public route');
    }
    if (contract.responseType === 'redirect' && (contract.auth !== 'public' || contract.method !== 'GET')) {
        problems.push('redirect outside a public GET route');
    }
    if (contract.path.includes('/:') && contract.input.params === null) {
        problems.push('path parameters without a schema');
    }
    if (isSignatureMode(contract.auth) && (contract.input.body === null || contract.input.headers === null)) {
        problems.push('signed route without a body and a header schema');
    }
    if (contract.auth === 'engine-signature' && contract.input.body === null) {
        problems.push('engine-signed route without a body schema');
    }
    if (problems.length > 0) {
        throw new Error(`refusing to mount ${contract.method} ${contract.path}: ${problems.join(', ')}`);
    }
}

function parseWith(schema: z.ZodType | null, value: unknown): ParseOutcome {
    if (schema === null) {
        return { kind: 'ok', value: undefined };
    }
    const result = schema.safeParse(value);
    return result.success ? { kind: 'ok', value: result.data } : { kind: 'invalid' };
}

/** Reads at most `maxBytes`; past that it cancels the stream, so a chunked body is never buffered beyond the cap. */
async function readCapped(
    stream: ReadableStream<Uint8Array> | null,
    maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | 'too-large'> {
    if (stream === null) {
        return new Uint8Array(0);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = stream.getReader();
    for (;;) {
        const next = await reader.read();
        if (next.done) {
            break;
        }
        total += next.value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            return 'too-large';
        }
        chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function readBytes(
    context: Context,
    maxBodyBytes: number,
): Promise<Uint8Array<ArrayBuffer> | { readonly kind: 'invalid' | 'too-large' }> {
    const declared = context.req.header('Content-Length');
    if (declared !== undefined && !/^\d{1,15}$/.test(declared)) {
        return { kind: 'invalid' };
    }
    if (declared !== undefined && Number(declared) > maxBodyBytes) {
        return { kind: 'too-large' };
    }
    const bytes = await readCapped(context.req.raw.body, maxBodyBytes);
    return bytes === 'too-large' ? { kind: 'too-large' } : bytes;
}

/** The signature covers the bytes as sent, so they are verified before anything decodes or parses them. */
async function readSignedBody(
    context: Context,
    contract: RouteContract,
    mode: SignatureMode,
    verify: SignatureVerifier,
): Promise<ParseOutcome> {
    const bytes = await readBytes(context, contract.input.maxBodyBytes);
    if (!(bytes instanceof Uint8Array)) {
        return bytes;
    }
    const signature = context.req.header(SIGNATURE_HEADERS[mode]);
    if (signature === undefined) {
        return { kind: 'unsigned' };
    }
    const verified = await verify(bytes, signature);
    return verified.kind === 'verified' ? parseWith(contract.input.body, verified.payload) : { kind: 'unsigned' };
}

async function readBody(context: Context, contract: RouteContract): Promise<ParseOutcome> {
    const { body, maxBodyBytes } = contract.input;
    if (body === null) {
        return { kind: 'ok', value: undefined };
    }
    const bytes = await readBytes(context, maxBodyBytes);
    if (!(bytes instanceof Uint8Array)) {
        return bytes;
    }
    if (body === RAW_BODY) {
        return { kind: 'ok', value: bytes };
    }
    try {
        return parseWith(body, JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
    } catch {
        return { kind: 'invalid' };
    }
}

function pickHeaders(context: Context, schema: z.ZodType | null): Record<string, string> {
    if (schema === null) {
        return {};
    }
    const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape ?? {};
    return Object.fromEntries(
        Object.keys(shape).flatMap((name) => {
            const value = context.req.header(name);
            return value === undefined ? [] : [[name, value]];
        }),
    );
}

function requestContext(context: Context): RequestContext {
    return {
        signal: context.req.raw.signal,
        secretCookie: (name) => {
            const value = getCookie(context, name);
            return value !== undefined && SECRET_PATTERN.test(value) ? value : null;
        },
        header: (name) => context.req.header(name) ?? null,
        waitUntil: (task) => {
            context.executionCtx.waitUntil(task);
        },
    };
}

function withCookies(response: Response, cookies: readonly string[] | undefined): Response {
    for (const cookie of cookies ?? []) {
        response.headers.append('Set-Cookie', cookie);
    }
    return response;
}

/** The client address Cloudflare saw; rate limits fall back to one shared bucket if it is somehow missing. */
function clientIp(context: Context): string {
    return context.req.header('CF-Connecting-IP') ?? 'unknown';
}

function resourceFor(action: DashboardAction, session: ActiveSession): Resource {
    const rule = DASHBOARD_POLICY[action];
    switch (rule.scope) {
        case 'self':
            return { kind: 'account', userId: session.user.id };
        case 'org':
            return { kind: 'org', orgId: session.actor.orgId };
        case 'platform':
            return { kind: 'platform' };
    }
}

export function createRouteBinder(deps: RouteBinderDeps): RouteBinder {
    const routes: RouteContract[] = [];

    async function authenticate(
        contract: RouteContract,
        request: RequestContext,
    ): Promise<
        | { readonly kind: 'ok'; readonly session: ActiveSession | null }
        | { readonly kind: 'response'; readonly response: Response }
    > {
        // Header-signed routes were verified with their body, before any of it was parsed; engine-signed ones carry
        // their proof in the parsed body, which the handler verifies first; relays authenticated before everything.
        if (
            contract.auth === 'public' ||
            contract.auth === 'engine-signature' ||
            contract.auth === 'relay-token' ||
            isSignatureMode(contract.auth)
        ) {
            return { kind: 'ok', session: null };
        }
        const token = request.secretCookie(SESSION_COOKIE);
        const session = token === null ? null : await deps.resolveSession(token);
        if (session === null) {
            return {
                kind: 'response',
                response: withCookies(problemResponse(401, 'unauthorized'), [clearSessionCookie()]),
            };
        }
        const action = contract.permission as DashboardAction;
        const decision = deps.authorizer.can(session.actor, action, resourceFor(action, session));
        if (decision.kind === 'allowed') {
            return { kind: 'ok', session };
        }
        switch (decision.reason) {
            // What the actor may not see does not exist for them, so IDs cannot be probed.
            case 'not-member':
            case 'not-self':
                return { kind: 'response', response: problemResponse(404, 'not-found') };
            case 'recovery-cooldown':
            case 'step-up-required':
                return { kind: 'response', response: problemResponse(403, decision.reason) };
            case 'role':
            case 'platform-admin-only':
                return { kind: 'response', response: problemResponse(403, 'forbidden') };
        }
    }

    return {
        routes,
        bind(router, mount, contract, handler) {
            assertMountable(contract, mount);
            routes.push(contract);
            router.on(contract.method, contract.path.slice(mount.length), async (context) => {
                deps.routeTemplates.set(context.req.raw, contract.path);
                const { rateLimit } = contract;
                const limited = async (rule: RateLimitRuleName, key: string): Promise<boolean> => {
                    const outcome = await deps.rateLimiter.consume(rule, key, context.req.raw.signal);
                    if (outcome === 'unavailable') {
                        deps.logger.error('rate-limit.unavailable', { rule });
                    }
                    return outcome !== 'allowed';
                };
                if (rateLimit !== null && isIpRateLimit(rateLimit) && (await limited(rateLimit, clientIp(context)))) {
                    return problemResponse(429, 'rate-limited');
                }
                const { engineRateLimit } = contract;
                if (
                    engineRateLimit !== undefined &&
                    isEngineRateLimit(engineRateLimit) &&
                    (await limited(engineRateLimit, context.req.param('engineId') ?? ''))
                ) {
                    return problemResponse(429, 'rate-limited');
                }
                // A relay is known only by its key, so it authenticates before its own budget is counted.
                let relay: RelayActor | null = null;
                if (contract.auth === 'relay-token') {
                    relay = await deps.authenticateRelay(context.req.header('Authorization') ?? null, (task) => {
                        context.executionCtx.waitUntil(task);
                    });
                    if (relay === null) {
                        return problemResponse(401, 'unauthorized');
                    }
                    if (
                        rateLimit !== null &&
                        isRelayRateLimit(rateLimit) &&
                        (await limited(rateLimit, relay.relayId))
                    ) {
                        return problemResponse(429, 'rate-limited');
                    }
                }
                const body = isSignatureMode(contract.auth)
                    ? await readSignedBody(context, contract, contract.auth, deps.signatures[contract.auth])
                    : await readBody(context, contract);
                if (body.kind === 'too-large') {
                    return problemResponse(413, 'too-large');
                }
                if (body.kind === 'unsigned') {
                    return problemResponse(400, 'invalid-signature');
                }
                const params = parseWith(contract.input.params, context.req.param());
                const query = parseWith(contract.input.query, context.req.query());
                const headers = parseWith(contract.input.headers, pickHeaders(context, contract.input.headers));
                if (params.kind !== 'ok' || query.kind !== 'ok' || headers.kind !== 'ok' || body.kind !== 'ok') {
                    return problemResponse(400, 'invalid-request');
                }
                const request = requestContext(context);
                const auth = await authenticate(contract, request);
                if (auth.kind === 'response') {
                    return auth.response;
                }
                // The schemas above are the contract's own, so the parsed values have the contract's types.
                const input = {
                    params: params.value,
                    query: query.value,
                    headers: headers.value,
                    body: body.value,
                } as ParsedRouteInput<typeof contract>;
                const result = await handler({
                    input,
                    request,
                    session: auth.session as RouteArgs<typeof contract>['session'],
                    relay: relay as RouteArgs<typeof contract>['relay'],
                });
                switch (result.kind) {
                    case 'ok':
                        if (contract.responseType === 'text') {
                            return context.text(String(result.body), 200, {
                                'Content-Type': 'text/plain; charset=utf-8',
                            });
                        }
                        return withCookies(
                            result.status === 204
                                ? context.body(null, 204)
                                : context.json(result.body as unknown as object, result.status ?? 200),
                            result.setCookies,
                        );
                    case 'redirect':
                        if (contract.responseType !== 'redirect') {
                            throw new Error(`${contract.path} redirected without a redirect contract`);
                        }
                        // The browser shows the target instead, so a one-time URL never stays in the address bar; it
                        // must not be cached or sent on as a Referer either.
                        return withCookies(
                            new Response(null, {
                                status: 303,
                                headers: {
                                    Location: result.location,
                                    'Cache-Control': 'no-store',
                                    'Referrer-Policy': 'no-referrer',
                                },
                            }),
                            result.setCookies,
                        );
                    case 'problem':
                        return withCookies(
                            problemResponse(result.status, result.code, undefined, result.extensions),
                            result.setCookies,
                        );
                }
            });
        },
    };
}
