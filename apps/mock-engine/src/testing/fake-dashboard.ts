import type {
    Bytes,
    Ed25519PublicKey,
    EngineId,
    Hostname,
    HeartbeatVerification,
    LinkCode,
    RegisterEngineResponse,
    RegistrationErrorCode,
} from '@ptbk/protocol';
import {
    HEARTBEAT_SIGNATURE_HEADER,
    REGISTER_PATH,
    RegisterEngineRequest,
    Timestamp,
    defaultHostname,
    deriveEngineId,
    ed25519PublicKeyToBytes,
    generateLinkCode,
    heartbeatPath,
    verifyHeartbeat,
    verifyRegistration,
} from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { DashboardApi, HeartbeatCall, RegisterCall } from '../domain/dashboard/dashboard-api';
import { createSeededRandom } from './seeded-random';

/**
 * A stand-in for D-03 and D-05 (not built yet): it checks every registration with C-03's `verifyRegistration` and
 * every heartbeat with C-03's `verifyHeartbeat`, so a signing bug in the mock fails the test. Behaviour follows the
 * C-03 and D-03 briefs: one `invalid-link-code` for unknown and used codes, idempotent re-registration of a key in the
 * same organisation, `engine-exists` across organisations, `engine-suspended`, a per-organisation engine limit.
 */
export interface FakeDashboard {
    /** The dashboard in memory, as the domain sees it through the port. */
    readonly api: DashboardApi;
    /** The same dashboard over HTTP semantics (status codes, problem+json), for the fetch adapter. */
    readonly fetch: typeof fetch;
    issueLinkCode(org: string): LinkCode;
    suspend(engineId: EngineId): void;
    setEngineLimit(org: string, limit: number): void;
    /** Every registration request as received, after the strict schema. */
    readonly registerRequests: readonly RegisterEngineRequest[];
    /** Every heartbeat as received, with the dashboard's verdict. */
    readonly heartbeats: readonly ReceivedHeartbeat[];
    /** The registry row for an engine: organisation, version and mode as last registered. */
    engine(engineId: EngineId): StoredEngine | undefined;
    /** Replaces the next answers to registration (one per call; `null` answers normally). */
    overrideRegister(answer: ((request: RegisterEngineRequest) => RegisterAnswer) | null): void;
    /** While true, every call fails as if the network were down. */
    unreachable: boolean;
    /** Leave `serverTime` out of `stale-timestamp` problems. */
    omitServerTime: boolean;
    /** Sends a signed member revocation in every v2 reply to that engine until a heartbeat acks `id`. */
    queueRevocation(engineId: EngineId, id: string, token: string): void;
}

export interface ReceivedHeartbeat {
    readonly engineId: EngineId;
    readonly rawBody: Bytes;
    readonly signature: string | null;
    readonly verification: HeartbeatVerification;
}

export interface StoredEngine {
    readonly org: string;
    readonly publicKey: Bytes;
    readonly engineVersion: string;
    readonly mode: string;
    readonly suspended: boolean;
}

/** A raw answer: status and JSON body (or text, to send something that is not JSON). */
export interface RegisterAnswer {
    readonly status: number;
    readonly body: unknown;
}

export interface FakeDashboardOptions {
    readonly clock: Clock;
    readonly engineDomain: Hostname;
    readonly relays: readonly Hostname[];
    /** Added to the engine's clock to get the dashboard's: tests of clock skew. */
    readonly clockOffsetMs?: number;
    /** The member key's public half to send at registration; without it, like a dashboard without teams. */
    readonly memberKey?: Ed25519PublicKey;
}

const PROBLEM_STATUS: Readonly<Record<RegistrationErrorCode, number>> = {
    'invalid-link-code': 401,
    'bad-signature': 401,
    'engine-exists': 409,
    'engine-suspended': 403,
    'engine-limit': 402,
    'not-entitled': 403,
    'rate-limited': 429,
};

function problem(status: number, code: string, extra: Record<string, unknown> = {}): RegisterAnswer {
    return { status, body: { type: 'about:blank', title: code, status, code, ...extra } };
}

const HEARTBEAT_ANSWER: Readonly<Record<Exclude<HeartbeatVerification['kind'], 'stale-ts'>, [number, string]>> = {
    accepted: [204, ''],
    'bad-signature-header': [401, 'bad-signature'],
    'bad-signature': [401, 'bad-signature'],
    'invalid-body': [400, 'invalid-body'],
    'engine-mismatch': [400, 'engine-mismatch'],
    'replayed-seq': [409, 'replayed-seq'],
};

export function createFakeDashboard(options: FakeDashboardOptions): FakeDashboard {
    const random = createSeededRandom(7);
    const linkCodes = new Map<string, { readonly org: string; used: boolean }>();
    const engines = new Map<EngineId, StoredEngine>();
    const lastSeq = new Map<EngineId, number>();
    const limits = new Map<string, number>();
    const registerRequests: RegisterEngineRequest[] = [];
    const heartbeats: ReceivedHeartbeat[] = [];
    let registerOverride: ((request: RegisterEngineRequest) => RegisterAnswer) | null = null;
    const revocations = new Map<EngineId, Map<string, string>>();

    async function register(json: unknown): Promise<RegisterAnswer> {
        const parsed = RegisterEngineRequest.safeParse(json);
        if (!parsed.success) return problem(400, 'invalid-request');
        const request = parsed.data;
        registerRequests.push(request);
        if (registerOverride !== null) return registerOverride(request);
        if (!verifyRegistration(request)) return problem(401, 'bad-signature');
        const code = linkCodes.get(request.linkCode);
        if (code === undefined || code.used) return problem(PROBLEM_STATUS['invalid-link-code'], 'invalid-link-code');
        const publicKey = ed25519PublicKeyToBytes(request.enginePublicKey);
        const engineId = await deriveEngineId(publicKey);
        const existing = engines.get(engineId);
        if (existing !== undefined && existing.org !== code.org) return problem(409, 'engine-exists');
        if (existing?.suspended === true) return problem(403, 'engine-suspended');
        const inOrg = [...engines.values()].filter((engine) => engine.org === code.org).length;
        if (existing === undefined && inOrg >= (limits.get(code.org) ?? Infinity)) {
            return problem(PROBLEM_STATUS['engine-limit'], 'engine-limit');
        }
        code.used = true;
        engines.set(engineId, {
            org: code.org,
            publicKey,
            engineVersion: request.engineVersion,
            mode: request.mode,
            suspended: false,
        });
        const response: RegisterEngineResponse = {
            engineId,
            hostname: defaultHostname(engineId, options.engineDomain),
            relays: [...options.relays],
            memberKey: options.memberKey ?? null,
        };
        return { status: 200, body: response };
    }

    function serverNow(): Timestamp {
        const ms = options.clock.nowMs() + (options.clockOffsetMs ?? 0);
        return Timestamp.parse(new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    }

    async function heartbeat(engineId: EngineId, rawBody: Bytes, signature: string | null): Promise<RegisterAnswer> {
        const engine = engines.get(engineId);
        if (engine === undefined) return problem(404, 'not-found');
        if (engine.suspended) return problem(403, 'engine-suspended');
        const verification = await verifyHeartbeat({
            rawBody,
            signatureHeader: signature,
            engineId,
            publicKey: engine.publicKey,
            lastSeq: lastSeq.get(engineId) ?? null,
            now: serverNow(),
        });
        heartbeats.push({ engineId, rawBody: rawBody.slice(), signature, verification });
        if (verification.kind === 'accepted') {
            lastSeq.set(engineId, verification.heartbeat.seq);
            if (verification.heartbeat.v === 1) return { status: 204, body: null };
            const queued = revocations.get(engineId) ?? new Map<string, string>();
            for (const { id } of verification.heartbeat.acks) queued.delete(id);
            return { status: 200, body: { v: 1, revocations: [...queued.values()] } };
        }
        if (verification.kind === 'stale-ts') {
            return problem(401, 'stale-timestamp', fake.omitServerTime ? {} : { serverTime: verification.serverTime });
        }
        const [status, code] = HEARTBEAT_ANSWER[verification.kind];
        return problem(status, code);
    }

    const api: DashboardApi = {
        async register(request): Promise<RegisterCall> {
            if (fake.unreachable) return { kind: 'unavailable', status: null };
            const answer = await register(JSON.parse(JSON.stringify(request)));
            if (answer.status >= 200 && answer.status < 300) {
                return { kind: 'ok', response: answer.body as RegisterEngineResponse };
            }
            const { code } = answer.body as { code: string };
            return { kind: 'problem', status: answer.status, problem: { code, serverTime: null } };
        },
        async heartbeat(engineId, rawBody, signature): Promise<HeartbeatCall> {
            if (fake.unreachable) return { kind: 'unavailable' };
            const answer = await heartbeat(engineId, rawBody, signature);
            if (answer.status >= 200 && answer.status < 300) {
                const body = answer.body as { readonly revocations?: readonly string[] } | null;
                return { kind: 'accepted', status: answer.status, revocations: body?.revocations ?? [] };
            }
            const body = answer.body as { code: string; serverTime?: Timestamp };
            return {
                kind: 'refused',
                status: answer.status,
                problem: { code: body.code, serverTime: body.serverTime ?? null },
            };
        },
    };

    const httpFetch: typeof fetch = async (input, init) => {
        if (fake.unreachable) throw new TypeError('fetch failed');
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const raw = new Uint8Array(await request.arrayBuffer());
        let answer: RegisterAnswer;
        if (request.method === 'POST' && path === REGISTER_PATH) {
            let json: unknown;
            try {
                json = JSON.parse(new TextDecoder().decode(raw));
            } catch {
                json = undefined;
            }
            answer = await register(json);
        } else {
            const engineId = [...engines.keys()].find((id) => heartbeatPath(id) === path);
            answer =
                request.method === 'POST' && engineId !== undefined
                    ? await heartbeat(engineId, raw, request.headers.get(HEARTBEAT_SIGNATURE_HEADER))
                    : problem(404, 'not-found');
        }
        if (answer.body === null) return new Response(null, { status: answer.status });
        const isProblem = answer.status >= 400;
        return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), {
            status: answer.status,
            headers: { 'content-type': isProblem ? 'application/problem+json' : 'application/json' },
        });
    };

    const fake: FakeDashboard = {
        api,
        fetch: httpFetch,
        issueLinkCode(org) {
            const code = generateLinkCode(random);
            linkCodes.set(code, { org, used: false });
            return code;
        },
        suspend(engineId) {
            const engine = engines.get(engineId);
            if (engine !== undefined) engines.set(engineId, { ...engine, suspended: true });
        },
        setEngineLimit(org, limit) {
            limits.set(org, limit);
        },
        registerRequests,
        heartbeats,
        engine: (engineId) => engines.get(engineId),
        overrideRegister(answer) {
            registerOverride = answer;
        },
        unreachable: false,
        omitServerTime: false,
        queueRevocation(engineId, id, token) {
            const queued = revocations.get(engineId) ?? new Map<string, string>();
            queued.set(id, token);
            revocations.set(engineId, queued);
        },
    };
    return fake;
}
