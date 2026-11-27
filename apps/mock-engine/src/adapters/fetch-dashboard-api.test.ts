import type { EngineId, RegisterEngineRequest } from '@ptbk/protocol';
import {
    EngineVersion,
    HEARTBEAT_SIGNATURE_HEADER,
    Hostname,
    REGISTER_PATH,
    REGISTER_RESPONSE_MAX_BYTES,
    defaultHostname,
    heartbeatPath,
    signRegistration,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { DashboardApi } from '../domain/dashboard/dashboard-api';
import type { EngineIdentity } from '../domain/identity/engine-identity';
import { signerOf } from '../domain/identity/engine-identity';
import { createFakeClock } from '../testing/fake-clock';
import type { FakeClock } from '../testing/fake-clock';
import { createFakeDashboard } from '../testing/fake-dashboard';
import { flush } from '../testing/fake-dialer';
import { DEFAULT_DASHBOARD_TIMEOUT_MS, createFetchDashboardApi } from './fetch-dashboard-api';
import { createMemoryIdentityStore } from './memory-identity-store';

const BASE_URL = 'https://dashboard.ptbk.test';
const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const RELAYS = [Hostname.parse('relay-a.ptbk.test'), Hostname.parse('relay-b.ptbk.test')];
const VERSION = EngineVersion.parse('0.1.0');
const BODY = new TextEncoder().encode('{"v":1}');
const SIGNATURE = `ed25519=${'A'.repeat(86)}`;

async function identity(): Promise<EngineIdentity> {
    return createMemoryIdentityStore().loadOrCreate();
}

async function signedRequest(engine: EngineIdentity, linkCode: string): Promise<RegisterEngineRequest> {
    return signRegistration(signerOf(engine), {
        linkCode: linkCode as RegisterEngineRequest['linkCode'],
        engineVersion: VERSION,
        mode: 'tunnel',
    });
}

function apiWith(fetchImpl: typeof fetch, clock: FakeClock = createFakeClock(1_000)): DashboardApi {
    return createFetchDashboardApi({ baseUrl: BASE_URL, fetch: fetchImpl, clock });
}

function answering(response: () => Response): typeof fetch {
    return () => Promise.resolve(response());
}

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
    return json({ type: 'about:blank', title: code, status, code, ...extra }, status, 'application/problem+json');
}

const SIGNAL = new AbortController().signal;
const LINK_CODE = 'abcdefghijklmnopqrstuvwxya';

describe('createFetchDashboardApi: register', () => {
    it('posts the signed request to REGISTER_PATH and parses the registration', async () => {
        const clock = createFakeClock(1_000);
        const dashboard = createFakeDashboard({ clock, engineDomain: ENGINE_DOMAIN, relays: RELAYS });
        const engine = await identity();
        const request = await signedRequest(engine, dashboard.issueLinkCode('org-a'));
        const call = await apiWith(dashboard.fetch, clock).register(request, SIGNAL);
        expect(call).toEqual({
            kind: 'ok',
            response: {
                engineId: engine.engineId,
                hostname: defaultHostname(engine.engineId, ENGINE_DOMAIN),
                relays: RELAYS,
                memberKey: null,
                ownerSetupCommitment: null,
            },
        });
        expect(dashboard.registerRequests).toEqual([request]);
    });

    it('sends POST with JSON content type and accepts JSON or problem+json', async () => {
        const seen: Request[] = [];
        const engine = await identity();
        await apiWith((input, init) => {
            seen.push(new Request(input, init));
            return Promise.resolve(problem(400, 'invalid-link-code'));
        }).register(await signedRequest(engine, LINK_CODE), SIGNAL);
        const [request] = seen;
        expect(request?.method).toBe('POST');
        expect(request?.url).toBe(`${BASE_URL}${REGISTER_PATH}`);
        expect(request?.headers.get('content-type')).toBe('application/json');
        expect(request?.headers.get('accept')).toContain('application/problem+json');
        expect(request?.redirect).toBe('manual');
    });

    it('reads the response tolerantly: an unknown field is stripped, not refused', async () => {
        const engine = await identity();
        const response = {
            engineId: engine.engineId,
            hostname: defaultHostname(engine.engineId, ENGINE_DOMAIN),
            relays: RELAYS,
        };
        const call = await apiWith(answering(() => json({ ...response, addedLater: { x: 1 } }))).register(
            await signedRequest(engine, LINK_CODE),
            SIGNAL,
        );
        expect(call).toEqual({ kind: 'ok', response: { ...response, memberKey: null, ownerSetupCommitment: null } });
        expect(call.kind === 'ok' && 'addedLater' in call.response).toBe(false);
    });

    it.each([
        ['an invalid known field', () => json({ engineId: 'NOT-AN-ID', hostname: 'x.ptbk.test', relays: RELAYS })],
        ['no relays', () => json({ engineId: 'a'.repeat(26), hostname: 'x.ptbk.test', relays: [] })],
        ['a non-JSON body', () => new Response('<html>hello</html>', { status: 200 })],
        ['an empty body', () => new Response(null, { status: 200 })],
        [
            'a body over the size cap',
            () =>
                json({
                    engineId: 'a'.repeat(26),
                    hostname: 'x.ptbk.test',
                    relays: RELAYS,
                    padding: 'x'.repeat(REGISTER_RESPONSE_MAX_BYTES),
                }),
        ],
    ])('treats a success with %s as invalid-response', async (_name, response) => {
        const engine = await identity();
        const call = await apiWith(answering(response)).register(await signedRequest(engine, LINK_CODE), SIGNAL);
        expect(call).toEqual({ kind: 'invalid-response', status: 200 });
    });

    it('maps a problem+json answer to its code', async () => {
        const engine = await identity();
        const call = await apiWith(answering(() => problem(409, 'engine-exists', { extra: 'stripped' }))).register(
            await signedRequest(engine, LINK_CODE),
            SIGNAL,
        );
        expect(call).toEqual({ kind: 'problem', status: 409, problem: { code: 'engine-exists', serverTime: null } });
    });

    it.each([
        ['an HTML error page', () => new Response('<h1>Bad gateway</h1>', { status: 502 })],
        ['a problem without a code', () => json({ type: 'about:blank', title: 'x', status: 500 }, 500)],
        ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } })],
    ])('treats an error status with %s as unavailable with the status', async (_name, response) => {
        const engine = await identity();
        const status = response().status;
        const call = await apiWith(answering(response)).register(await signedRequest(engine, LINK_CODE), SIGNAL);
        expect(call).toEqual({ kind: 'unavailable', status });
    });

    it('treats a network failure as unavailable without a status', async () => {
        const engine = await identity();
        const call = await apiWith(() => Promise.reject(new TypeError('fetch failed'))).register(
            await signedRequest(engine, LINK_CODE),
            SIGNAL,
        );
        expect(call).toEqual({ kind: 'unavailable', status: null });
    });

    it('gives up after the timeout', async () => {
        const clock = createFakeClock(1_000);
        const engine = await identity();
        const hanging: typeof fetch = (_input, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(init.signal?.reason as Error);
                });
            });
        const pending = apiWith(hanging, clock).register(await signedRequest(engine, LINK_CODE), SIGNAL);
        await flush();
        clock.advance(DEFAULT_DASHBOARD_TIMEOUT_MS - 1);
        await flush();
        let settled = false;
        void pending.then(() => (settled = true));
        await flush();
        expect(settled).toBe(false);
        clock.advance(1);
        expect(await pending).toEqual({ kind: 'unavailable', status: null });
        expect(clock.pendingTimers()).toBe(0);
    });

    it('honours a custom timeout and clears its timer after an answer', async () => {
        const clock = createFakeClock(1_000);
        const api = createFetchDashboardApi({
            baseUrl: BASE_URL,
            fetch: answering(() => problem(400, 'invalid-link-code')),
            clock,
            timeoutMs: 50,
        });
        const engine = await identity();
        await api.register(await signedRequest(engine, LINK_CODE), SIGNAL);
        expect(clock.pendingTimers()).toBe(0);
    });
});

describe('createFetchDashboardApi: heartbeat', () => {
    const ENGINE_ID = 'abcdefghijklmnopqrstuvwxyz' as EngineId;

    it('posts the exact raw bytes with the signature header to the engine heartbeat path', async () => {
        const seen: { request: Request; body: Uint8Array }[] = [];
        const api = apiWith(async (input, init) => {
            const request = new Request(input, init);
            seen.push({ request, body: new Uint8Array(await request.arrayBuffer()) });
            return new Response(null, { status: 204 });
        });
        expect(await api.heartbeat(ENGINE_ID, BODY, SIGNATURE, SIGNAL)).toEqual({
            kind: 'accepted',
            status: 204,
            revocations: [],
        });
        const [sent] = seen;
        expect(sent?.request.method).toBe('POST');
        expect(sent?.request.url).toBe(`${BASE_URL}${heartbeatPath(ENGINE_ID)}`);
        expect(sent?.request.headers.get(HEARTBEAT_SIGNATURE_HEADER)).toBe(SIGNATURE);
        expect(sent?.request.headers.get('content-type')).toBe('application/json');
        expect(sent?.body).toEqual(BODY);
    });

    it('accepts any 2xx, reading no revocations from a body that is not a heartbeat reply', async () => {
        const api = apiWith(answering(() => json({ ignored: true }, 200)));
        expect(await api.heartbeat(ENGINE_ID, BODY, SIGNATURE, SIGNAL)).toEqual({
            kind: 'accepted',
            status: 200,
            revocations: [],
        });
    });

    it('reads the revocations of a v2 reply, unknown fields stripped', async () => {
        const api = apiWith(answering(() => json({ v: 1, revocations: ['a.b'], later: true }, 200)));
        expect(await api.heartbeat(ENGINE_ID, BODY, SIGNATURE, SIGNAL)).toEqual({
            kind: 'accepted',
            status: 200,
            revocations: ['a.b'],
        });
    });

    it('reads serverTime from a stale-timestamp problem', async () => {
        const serverTime = '2026-10-20T12:05:00Z';
        const api = apiWith(answering(() => problem(401, 'stale-timestamp', { serverTime })));
        expect(await api.heartbeat(ENGINE_ID, BODY, SIGNATURE, SIGNAL)).toEqual({
            kind: 'refused',
            status: 401,
            problem: { code: 'stale-timestamp', serverTime },
        });
    });

    it('reports serverTime as null when the problem has none', async () => {
        const api = apiWith(answering(() => problem(401, 'stale-timestamp')));
        expect(await api.heartbeat(ENGINE_ID, BODY, SIGNATURE, SIGNAL)).toEqual({
            kind: 'refused',
            status: 401,
            problem: { code: 'stale-timestamp', serverTime: null },
        });
    });

    it('refuses with no problem when the error body is not a problem', async () => {
        const api = apiWith(answering(() => new Response('rate limited', { status: 429 })));
        expect(await api.heartbeat(ENGINE_ID, BODY, SIGNATURE, SIGNAL)).toEqual({
            kind: 'refused',
            status: 429,
            problem: null,
        });
    });

    it('is unavailable when fetch throws', async () => {
        const api = apiWith(() => Promise.reject(new TypeError('fetch failed')));
        expect(await api.heartbeat(ENGINE_ID, BODY, SIGNATURE, SIGNAL)).toEqual({ kind: 'unavailable' });
    });

    it('is unavailable when the caller aborts', async () => {
        const controller = new AbortController();
        const api = apiWith((_input, init) => {
            if (init?.signal?.aborted === true) return Promise.reject(init.signal.reason as Error);
            return Promise.resolve(new Response(null, { status: 204 }));
        });
        controller.abort(new Error('stopping'));
        expect(await api.heartbeat(ENGINE_ID, BODY, SIGNATURE, controller.signal)).toEqual({ kind: 'unavailable' });
    });

    it('carries a heartbeat to the fake dashboard, whose verdict comes back', async () => {
        const clock = createFakeClock(Date.parse('2026-10-20T12:00:00Z'));
        const dashboard = createFakeDashboard({ clock, engineDomain: ENGINE_DOMAIN, relays: RELAYS });
        const engine = await identity();
        const api = apiWith(dashboard.fetch, clock);
        await api.register(await signedRequest(engine, dashboard.issueLinkCode('org-a')), SIGNAL);
        expect(await api.heartbeat(engine.engineId, BODY, SIGNATURE, SIGNAL)).toEqual({
            kind: 'refused',
            status: 401,
            problem: { code: 'bad-signature', serverTime: null },
        });
        expect(dashboard.heartbeats.map((received) => received.verification.kind)).toEqual(['bad-signature']);
        expect(dashboard.heartbeats[0]?.rawBody).toEqual(BODY);
    });
});
