import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';

import type {
    Bytes,
    EngineId,
    HeartbeatVerification,
    Hostname,
    LinkCode,
    RegisterEngineResponse,
    Signer,
} from '@ptbk/protocol';
import {
    EngineId as EngineIdSchema,
    HEARTBEAT_SIGNATURE_HEADER,
    REGISTER_PATH,
    REGISTER_REQUEST_MAX_BYTES,
    RegisterEngineRequest,
    Timestamp,
    createWebCryptoSigner,
    ed25519PublicKeyFromBytes,
    generateEd25519KeyPair,
    defaultHostname,
    deriveEngineId,
    ed25519PublicKeyToBytes,
    generateLinkCode,
    verifyHeartbeat,
    verifyRegistration,
} from '@ptbk/protocol';

import type { EngineProcess } from '../harness/engine-process';
import { LOOPBACK_DOMAIN, listenLoopback } from '../harness/loopback';
import type { EngineOptions, PlatformCheckContext } from '../harness/platform';

/** The dashboard's own hostname; its certificate comes from the run's CA. */
export const FAKE_DASHBOARD_HOSTNAME = `dashboard.${LOOPBACK_DOMAIN}`;

/**
 * Relays a registration answers with when a check does not care: `.invalid` never resolves (RFC 6761), so an engine
 * dialling them fails fast and touches nothing on the machine.
 */
export const UNREACHABLE_RELAYS: readonly Hostname[] = ['relay-a.conformance.invalid' as Hostname];

/** Bodies are kept up to this size, so an oversized request is recorded and still answered. */
const MAX_RECORDED_BODY_BYTES = 64 * 1024;
const HEARTBEAT_PATH = /^\/v1\/engines\/([^/]+)\/heartbeat$/;

/** An answer to send instead of the dashboard's own. */
export interface DashboardAnswer {
    readonly status: number;
    /** JSON bodies are sent as `application/json`, problems as `application/problem+json`. */
    readonly body?: string;
    readonly contentType?: string;
}

export interface ReceivedRegistration {
    /** `Date.now()` when the request arrived. */
    readonly at: number;
    readonly rawBody: Buffer;
    readonly contentType: string | null;
    /** Null when the body is not JSON or fails the strict schema. */
    readonly request: RegisterEngineRequest | null;
    /** `verifyRegistration` over the parsed request; false when it did not parse. */
    readonly signatureValid: boolean;
    /** The engine ID its public key derives, when it parsed. */
    readonly engineId: EngineId | null;
    readonly answer: DashboardAnswer;
}

export interface ReceivedHeartbeat {
    readonly at: number;
    /** The engine ID in the path, as sent (unparsed). */
    readonly pathEngineId: string;
    readonly rawBody: Buffer;
    readonly signatureHeader: string | null;
    /** `verifyHeartbeat`'s verdict, or null when the path names no engine this dashboard registered. */
    readonly verification: HeartbeatVerification | null;
    readonly answer: DashboardAnswer;
}

interface StoredEngine {
    readonly org: string;
    readonly publicKey: Bytes;
    suspended: boolean;
    lastSeq: number | null;
}

export interface FakeDashboardOptions {
    /** What a successful registration answers as `relays`. */
    readonly relays?: readonly Hostname[];
    /** Scripted answers: return one to send it instead of the dashboard's own, or undefined to answer normally. */
    readonly onRegister?: (registration: Omit<ReceivedRegistration, 'answer'>) => DashboardAnswer | undefined;
    readonly onHeartbeat?: (heartbeat: Omit<ReceivedHeartbeat, 'answer'>) => DashboardAnswer | undefined;
    /**
     * Changes the body of a successful registration answer, after the dashboard has stored the engine: extra fields,
     * another identity, padding. The engine is registered either way, as with a dashboard that answers wrongly.
     */
    readonly decorateRegistration?: (response: RegisterEngineResponse) => unknown;
}

export interface FakeDashboard {
    /** `PTBK_DASHBOARD_URL` for the engine. */
    readonly env: { readonly PTBK_DASHBOARD_URL: string };
    readonly url: string;
    readonly registrations: readonly ReceivedRegistration[];
    readonly heartbeats: readonly ReceivedHeartbeat[];
    /** A new one-time link code for `org` (default `org-conformance`). */
    issueLinkCode(org?: string): LinkCode;
    suspend(engineId: EngineId): void;
    /** Signs access tickets and member revocations; its public half goes out as `memberKey` at registration. */
    readonly memberSigner: Signer;
    /** Sends a signed revocation in the reply to every accepted v2 heartbeat of that engine until one acks `id`. */
    queueRevocation(engineId: EngineId, id: string, token: string): void;
    /** Resolves with the first value `select` returns, re-checked after every request, or rejects after `timeoutMs`. */
    waitFor<T>(select: () => T | undefined, timeoutMs: number, signal: AbortSignal): Promise<T>;
    close(): Promise<void>;
}

/** A problem+json answer, as the dashboard sends them. */
export function problemAnswer(status: number, code: string, extra: Readonly<Record<string, string>> = {}) {
    return {
        status,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: `https://ptbk.io/problems/${code}`, title: code, status, code, ...extra }),
    } satisfies DashboardAnswer;
}

export function jsonAnswer(status: number, value: unknown): DashboardAnswer {
    return { status, contentType: 'application/json', body: JSON.stringify(value) };
}

/** Thrown by `waitFor` when nothing matched in time; the message is safe for a report. */
export class WaitTimeout extends Error {
    override readonly name = 'WaitTimeout';
}

/**
 * The dashboard's engine-facing API (D-03, D-05) on loopback HTTPS, checking every request with C-03's own verify
 * functions over the exact bytes. By default it answers as the real dashboard does: link codes consumed once,
 * idempotent re-registration in the same organisation, `engine-exists` across organisations, `engine-suspended`.
 */
export async function startFakeDashboard(
    ctx: PlatformCheckContext,
    options: FakeDashboardOptions = {},
): Promise<FakeDashboard> {
    const relays = options.relays ?? UNREACHABLE_RELAYS;
    const linkCodes = new Map<string, string>();
    const consumed = new Set<string>();
    const engines = new Map<EngineId, StoredEngine>();
    const memberSigner = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
    const pendingRevocations = new Map<EngineId, Map<string, string>>();
    const registrations: ReceivedRegistration[] = [];
    const heartbeats: ReceivedHeartbeat[] = [];
    const waiters = new Set<() => void>();
    const notify = (): void => {
        for (const waiter of [...waiters]) waiter();
    };

    async function register(at: number, incoming: IncomingMessage, rawBody: Buffer): Promise<DashboardAnswer> {
        const request = parseRegistration(rawBody);
        const signatureValid = request !== null && verifyRegistration(request);
        const engineId =
            request === null ? null : await deriveEngineId(ed25519PublicKeyToBytes(request.enginePublicKey));
        const received = {
            at,
            rawBody,
            contentType: incoming.headers['content-type'] ?? null,
            request,
            signatureValid,
            engineId,
        };
        const answer = options.onRegister?.(received) ?? defaultRegistrationAnswer(received);
        registrations.push({ ...received, answer });
        return answer;
    }

    function defaultRegistrationAnswer(received: Omit<ReceivedRegistration, 'answer'>): DashboardAnswer {
        if (received.rawBody.length > REGISTER_REQUEST_MAX_BYTES) return problemAnswer(413, 'too-large');
        const { request, engineId } = received;
        if (request === null || engineId === null) return problemAnswer(400, 'invalid-request');
        if (!received.signatureValid) return problemAnswer(401, 'bad-signature');
        const org = linkCodes.get(request.linkCode);
        if (org === undefined || consumed.has(request.linkCode)) return problemAnswer(401, 'invalid-link-code');
        const existing = engines.get(engineId);
        if (existing !== undefined && existing.org !== org) return problemAnswer(409, 'engine-exists');
        if (existing?.suspended === true) return problemAnswer(403, 'engine-suspended');
        consumed.add(request.linkCode);
        if (existing === undefined) {
            engines.set(engineId, {
                org,
                publicKey: ed25519PublicKeyToBytes(request.enginePublicKey),
                suspended: false,
                lastSeq: null,
            });
        }
        const response: RegisterEngineResponse = {
            engineId,
            hostname: defaultHostname(engineId, ctx.engineDomain),
            relays: [...relays],
            memberKey: ed25519PublicKeyFromBytes(memberSigner.publicKey()),
        };
        return jsonAnswer(200, options.decorateRegistration?.(response) ?? response);
    }

    async function heartbeat(at: number, incoming: IncomingMessage, rawBody: Buffer, pathEngineId: string) {
        const header = incoming.headers[HEARTBEAT_SIGNATURE_HEADER.toLowerCase()];
        const signatureHeader = typeof header === 'string' ? header : null;
        const parsedId = EngineIdSchema.safeParse(pathEngineId);
        const engine = parsedId.success ? engines.get(parsedId.data) : undefined;
        const verification =
            engine === undefined || !parsedId.success
                ? null
                : await verifyHeartbeat({
                      rawBody: new Uint8Array(rawBody),
                      signatureHeader,
                      engineId: parsedId.data,
                      publicKey: engine.publicKey,
                      lastSeq: engine.lastSeq,
                      now: Timestamp.parse(new Date(at).toISOString()),
                  });
        const received = { at, pathEngineId, rawBody, signatureHeader, verification };
        if (parsedId.success && verification?.kind === 'accepted' && verification.heartbeat.v === 2) {
            const pending = pendingRevocations.get(parsedId.data);
            for (const ack of verification.heartbeat.acks) pending?.delete(ack.id);
        }
        const answer =
            options.onHeartbeat?.(received) ??
            defaultHeartbeatAnswer(engine, verification, parsedId.success ? parsedId.data : null);
        // Like the dashboard, only a beat it accepted moves the replay window, whatever a script answered.
        if (engine !== undefined && verification?.kind === 'accepted' && answer.status < 300) {
            engine.lastSeq = verification.heartbeat.seq;
        }
        heartbeats.push({ ...received, answer });
        return answer;
    }

    function defaultHeartbeatAnswer(
        engine: StoredEngine | undefined,
        verification: HeartbeatVerification | null,
        engineId: EngineId | null,
    ): DashboardAnswer {
        if (engine === undefined || verification === null) return problemAnswer(404, 'not-found');
        if (engine.suspended) return problemAnswer(403, 'engine-suspended');
        switch (verification.kind) {
            case 'accepted': {
                // A v1 engine handles no revocations, so it gets the old empty answer.
                if (verification.heartbeat.v === 1 || engineId === null) return { status: 204 };
                const revocations = [...(pendingRevocations.get(engineId)?.values() ?? [])];
                return jsonAnswer(200, { v: 1, revocations });
            }
            case 'bad-signature-header':
            case 'bad-signature':
                return problemAnswer(401, verification.kind);
            case 'invalid-body':
            case 'engine-mismatch':
                return problemAnswer(400, verification.kind);
            case 'replayed-seq':
                return problemAnswer(409, 'replayed-seq');
            case 'stale-ts':
                return problemAnswer(401, 'stale-timestamp', { serverTime: verification.serverTime });
        }
    }

    async function handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
        const at = Date.now();
        const rawBody = await readBody(incoming);
        const path = new URL(incoming.url ?? '/', 'https://dashboard.invalid').pathname;
        const beat = HEARTBEAT_PATH.exec(path);
        let answer: DashboardAnswer;
        if (incoming.method === 'POST' && path === REGISTER_PATH) answer = await register(at, incoming, rawBody);
        else if (incoming.method === 'POST' && beat?.[1] !== undefined)
            answer = await heartbeat(at, incoming, rawBody, beat[1]);
        else answer = problemAnswer(404, 'not-found');
        outgoing.writeHead(
            answer.status,
            answer.contentType === undefined ? {} : { 'Content-Type': answer.contentType },
        );
        outgoing.end(answer.body);
        notify();
    }

    const credentials = ctx.ca.issue([FAKE_DASHBOARD_HOSTNAME]);
    const servers: ReturnType<typeof createServer>[] = [];
    const listener = await listenLoopback(() => {
        const server = createServer(
            { cert: credentials.certPem, key: credentials.keyPem, minVersion: 'TLSv1.2' },
            (incoming, outgoing) => {
                handle(incoming, outgoing).catch(() => {
                    if (!outgoing.headersSent) outgoing.writeHead(500);
                    outgoing.end();
                });
            },
        );
        servers.push(server);
        return server;
    });
    const url = `https://${FAKE_DASHBOARD_HOSTNAME}:${String(listener.port)}`;

    return {
        env: { PTBK_DASHBOARD_URL: url },
        url,
        registrations,
        heartbeats,
        issueLinkCode(org = 'org-conformance') {
            const code = generateLinkCode(ctx.random);
            linkCodes.set(code, org);
            return code;
        },
        suspend(engineId) {
            const engine = engines.get(engineId);
            if (engine !== undefined) engine.suspended = true;
        },
        memberSigner,
        queueRevocation(engineId, id, token) {
            const pending = pendingRevocations.get(engineId) ?? new Map<string, string>();
            pending.set(id, token);
            pendingRevocations.set(engineId, pending);
        },
        waitFor(select, timeoutMs, signal) {
            return new Promise((resolve, reject) => {
                const finish = (): void => {
                    clearTimeout(timer);
                    waiters.delete(check);
                    signal.removeEventListener('abort', aborted);
                };
                const check = (): void => {
                    let value: ReturnType<typeof select>;
                    try {
                        value = select();
                    } catch (error) {
                        finish();
                        reject(error instanceof Error ? error : new Error('waitFor selector failed'));
                        return;
                    }
                    if (value === undefined) return;
                    finish();
                    resolve(value);
                };
                const aborted = (): void => {
                    finish();
                    reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
                };
                const timer = setTimeout(() => {
                    finish();
                    reject(new WaitTimeout(`nothing matched within ${String(timeoutMs)} ms`));
                }, timeoutMs);
                waiters.add(check);
                signal.addEventListener('abort', aborted, { once: true });
                check();
            });
        },
        async close() {
            for (const server of servers) server.closeAllConnections();
            await listener.close();
        },
    };
}

function parseRegistration(rawBody: Buffer): RegisterEngineRequest | null {
    if (rawBody.length > REGISTER_REQUEST_MAX_BYTES) return null;
    let json: unknown;
    try {
        json = JSON.parse(rawBody.toString('utf8'));
    } catch {
        return null;
    }
    const parsed = RegisterEngineRequest.safeParse(json);
    return parsed.success ? parsed.data : null;
}

async function readBody(incoming: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of incoming as AsyncIterable<Buffer>) {
        length += chunk.length;
        if (length <= MAX_RECORDED_BODY_BYTES) chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export interface RegisteredEngineOptions extends EngineOptions {
    /** What the dashboard answers as the engine's relays (default: unreachable ones). */
    readonly relays?: readonly Hostname[];
    /** Scripted answers for the dashboard; a script must let the first registration and heartbeat through. */
    readonly dashboard?: Omit<FakeDashboardOptions, 'relays'>;
}

export interface EngineIdentity {
    readonly engineId: EngineId;
    /** Base64url, as in the registration request. */
    readonly enginePublicKey: string;
}

export interface RegisteredEngine {
    readonly engine: EngineProcess;
    readonly dashboard: FakeDashboard;
    readonly linkCode: LinkCode;
    readonly identity: EngineIdentity;
    /** Restarts with the same data directory and resolves once the engine is up again (its next accepted heartbeat). */
    restart(patch?: Readonly<Record<string, string | null>>): Promise<void>;
    /** Resolves with the first heartbeat the dashboard accepted after `afterMs` (`Date.now()`). */
    nextAcceptedHeartbeat(afterMs: number): Promise<ReceivedHeartbeat>;
}

/**
 * An engine that registered with a fake dashboard and sent its first accepted heartbeat: the starting point for
 * suites that are not about registration. `identity` is known before the engine dials its relays.
 */
export async function startRegisteredEngine(
    ctx: PlatformCheckContext,
    options: RegisteredEngineOptions = {},
): Promise<RegisteredEngine> {
    const dashboard = ctx.use(
        await startFakeDashboard(ctx, {
            ...options.dashboard,
            ...(options.relays === undefined ? {} : { relays: options.relays }),
        }),
    );
    const linkCode = dashboard.issueLinkCode();
    const engine = await ctx.engine({
        ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
        env: { ...dashboard.env, PTBK_LINK_CODE: linkCode, ...options.env },
    });
    await engine.start();
    const timeoutMs = ctx.expectations.startTimeoutMs;
    const registered = await waitWhileRunning(ctx, engine, dashboard, 'register', () =>
        dashboard.registrations.find((entry) => entry.answer.status === 200 && entry.request !== null),
    );
    const identity: EngineIdentity = {
        engineId: registered.engineId as EngineId,
        enginePublicKey: registered.request?.enginePublicKey ?? '',
    };
    const nextAcceptedHeartbeat = (afterMs: number): Promise<ReceivedHeartbeat> =>
        waitWhileRunning(
            ctx,
            engine,
            dashboard,
            'send an accepted heartbeat',
            () =>
                dashboard.heartbeats.find(
                    (beat) =>
                        beat.at >= afterMs && beat.verification?.kind === 'accepted' && beat.answer.status === 204,
                ),
            timeoutMs + ctx.expectations.heartbeatIntervalMs,
        );
    await nextAcceptedHeartbeat(engine.startedAt ?? 0);
    return {
        engine,
        dashboard,
        linkCode,
        identity,
        async restart(patch) {
            await engine.restart(patch);
            await nextAcceptedHeartbeat(engine.startedAt ?? Date.now());
        },
        nextAcceptedHeartbeat,
    };
}

/**
 * Waits for the dashboard to see something, failing early, with a readable reason, when the engine exits instead.
 */
export async function waitWhileRunning<T>(
    ctx: PlatformCheckContext,
    engine: EngineProcess,
    dashboard: FakeDashboard,
    what: string,
    select: () => T | undefined,
    timeoutMs = ctx.expectations.startTimeoutMs,
): Promise<T> {
    const stopWatching = new AbortController();
    const signal = AbortSignal.any([ctx.signal, stopWatching.signal]);
    const exited = engine.waitForExit(timeoutMs, signal).then((exit) => {
        if (exit === null) return new Promise<never>(() => undefined);
        const how = exit.signal ?? `status ${String(exit.code)}`;
        throw new EngineExited(`the engine exited (${how}) before it could ${what}`);
    });
    try {
        return await Promise.race([dashboard.waitFor(select, timeoutMs, signal), exited]);
    } catch (error) {
        if (error instanceof WaitTimeout) {
            throw new WaitTimeout(`the engine did not ${what} within ${String(timeoutMs)} ms`);
        }
        throw error;
    } finally {
        stopWatching.abort();
    }
}

export class EngineExited extends Error {
    override readonly name = 'EngineExited';
}
