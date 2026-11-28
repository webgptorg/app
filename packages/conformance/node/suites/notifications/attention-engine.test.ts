import { ENGINE_API_PREFIX, JOIN_OPTIONS_PATH, JOIN_STATUS_PATH, JOIN_VERIFY_PATH } from '@ptbk/engine-api';
import { EngineId, createWebCryptoSigner, generateEd25519KeyPair, verifyMemberRevocation } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createSeededRandom } from '../../../src/index';
import { WaitTimeout } from '../../fakes/dashboard';
import type { PlatformCheckContext } from '../../harness/platform';
import type { JoinableEngine } from '../member-access/join';
import { attentionEngine } from './attention';

const ENGINE_ID = 'abcdefghijklmnopqrstuvwxyz';
const ORIGIN = `https://${ENGINE_ID}.engines.localhost`;
const OPTIONS = { challenge: 'Y2hhbGxlbmdl', rp: { id: `${ENGINE_ID}.engines.localhost` } };

type Route = (body: unknown, headers: Headers) => Response;

interface Beat {
    readonly at: number;
    readonly rawBody: Buffer;
    readonly verification: { readonly kind: string; readonly heartbeat?: { readonly v: number } } | null;
    readonly answer: { readonly status: number };
}

/** A joinable engine whose network and dashboard are plain functions, so the wiring runs without a process. */
async function fakeJoinable(routes: Readonly<Record<string, Route>>, beats: Beat[] = []) {
    const keys = await generateEd25519KeyPair({ extractable: false });
    const memberSigner = await createWebCryptoSigner(keys);
    const queued: { id: string; token: string }[] = [];
    const seen: { method: string; path: string; headers: Headers }[] = [];
    const ctx = {
        random: createSeededRandom(5),
        signal: AbortSignal.timeout(10_000),
        expectations: { heartbeatIntervalMs: 10, startTimeoutMs: 10 },
    } as unknown as PlatformCheckContext;
    const dashboard = {
        heartbeats: beats,
        memberSigner,
        queueRevocation: (_engineId: string, id: string, token: string) => queued.push({ id, token }),
        waitFor: <T>(select: () => T | undefined): Promise<T> => {
            const value = select();
            return value === undefined ? Promise.reject(new WaitTimeout('timed out')) : Promise.resolve(value);
        },
    };
    const engine = { waitForExit: () => new Promise(() => undefined) };
    const joinable = {
        ctx,
        engineId: ENGINE_ID,
        registered: { dashboard, engine },
        endpoint: {
            baseUrl: new URL(ORIGIN),
            fetch: (input: string | URL | Request, init?: RequestInit) => {
                const request = new Request(input, init);
                const path = new URL(request.url).pathname;
                seen.push({ method: request.method, path, headers: request.headers });
                const route = routes[`${request.method} ${path}`];
                if (route === undefined) return Promise.resolve(Response.json({ code: 'not-found' }, { status: 404 }));
                return request
                    .text()
                    .then((text) => route(text === '' ? undefined : JSON.parse(text), request.headers));
            },
        },
    } as unknown as JoinableEngine;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    return { joinable, queued, seen, publicKey };
}

const beat = (at: number, v: number, status = 204, kind = 'accepted'): Beat => ({
    at,
    rawBody: Buffer.from(JSON.stringify({ v, seq: at })),
    verification: { kind, heartbeat: { v } },
    answer: { status },
});

const JOINS: Readonly<Record<string, Route>> = {
    [`POST ${JOIN_OPTIONS_PATH}`]: () => Response.json({ options: OPTIONS }),
    [`POST ${JOIN_VERIFY_PATH}`]: () => Response.json({ code: '123456', request: 'request-token' }, { status: 201 }),
    [`GET ${ENGINE_API_PREFIX}/access-requests`]: () =>
        Response.json({ items: [{ id: 'request-1' }], nextCursor: null }),
    [`POST ${ENGINE_API_PREFIX}/access-requests/request-1/approve`]: () =>
        Response.json({ id: 'member-9' }, { status: 201 }),
    [`POST ${JOIN_STATUS_PATH}`]: () =>
        Response.json({ state: 'approved' }, { headers: { 'set-cookie': 'session=joined; Path=/; Secure' } }),
};

describe('the attention checks’ engine wiring', () => {
    it('reads every heartbeat since a time, and waits for the nth accepted v2 one or says why it never came', async () => {
        const beats = [beat(1, 2), beat(2, 1), beat(3, 2, 503), beat(4, 2, 204, 'invalid-body'), beat(5, 2)];
        const { joinable } = await fakeJoinable({}, beats);
        const engine = attentionEngine(joinable, { cookie: 'owner=1' }, { raise: () => Promise.resolve('n') });
        expect(engine.sent(0).map(({ at }) => at)).toEqual([1, 2, 3, 4, 5]);
        expect(engine.sent(5).map(({ text }) => JSON.parse(text) as unknown)).toEqual([{ v: 2, seq: 5 }]);
        expect(await engine.awaitBeat(0, 2)).toMatchObject({ at: 5 });
        expect(await engine.awaitBeat(0, 3)).toMatch(/did not send 3 heartbeats/);
    });

    it('sends same-origin requests with a cookie or a bearer token and reads the problem code', async () => {
        const { joinable, seen } = await fakeJoinable({
            'GET /api/v1/me': () => Response.json({ code: 'unauthenticated' }, { status: 401 }),
            'PUT /api/v1/settings/dashboard-attention': () => new Response('not json', { status: 500 }),
        });
        const engine = attentionEngine(joinable, { cookie: 'owner=1' }, { raise: () => Promise.resolve('n') });
        expect(await engine.api('GET', '/api/v1/me', undefined, { bearer: 'token' })).toMatchObject({
            status: 401,
            code: 'unauthenticated',
            cookie: null,
        });
        expect(
            await engine.api('PUT', '/api/v1/settings/dashboard-attention', { enabled: true }, engine.owner),
        ).toEqual({ status: 500, code: null, body: null, cookie: null });
        expect(seen[0]?.headers.get('authorization')).toBe('Bearer token');
        expect(seen[1]?.headers.get('cookie')).toBe('owner=1');
        expect(seen[1]?.headers.get('origin')).toBe(ORIGIN);
        expect(seen[1]?.headers.get('content-type')).toBe('application/json');
    });

    it('admits a person through the join page and the owner’s approval, with their session', async () => {
        const { joinable } = await fakeJoinable(JOINS);
        const engine = attentionEngine(joinable, { cookie: 'owner=1' }, { raise: () => Promise.resolve('n') });
        const admitted = await engine.admit();
        expect(admitted).toMatchObject({ memberId: 'member-9', session: { cookie: 'session=joined' } });
        expect(typeof admitted === 'object' && admitted.dashboardUserId).toMatch(/^conformance-/);
    });

    it('says which step failed when the join or the approval is refused, and admits without a session cookie', async () => {
        const refusedJoin = await fakeJoinable({
            ...JOINS,
            [`POST ${JOIN_OPTIONS_PATH}`]: () => Response.json({ code: 'ticket-invalid' }, { status: 403 }),
        });
        const owner = { cookie: 'owner=1' };
        const raise = { raise: () => Promise.resolve('n') };
        expect(await attentionEngine(refusedJoin.joinable, owner, raise).admit()).toBe('the join failed at options');
        const refusedApproval = await fakeJoinable({
            ...JOINS,
            [`POST ${ENGINE_API_PREFIX}/access-requests/request-1/approve`]: () =>
                Response.json({ code: 'forbidden' }, { status: 403 }),
        });
        expect(await attentionEngine(refusedApproval.joinable, owner, raise).admit()).toBe(
            'approving the request failed',
        );
        const noCookie = await fakeJoinable({
            ...JOINS,
            [`POST ${JOIN_STATUS_PATH}`]: () => Response.json({ state: 'approved' }),
        });
        expect(await attentionEngine(noCookie.joinable, owner, raise).admit()).toMatchObject({ session: null });
    });

    it('revokes through the heartbeat reply with a revocation signed by the member key', async () => {
        const { joinable, queued, publicKey } = await fakeJoinable({});
        const engine = attentionEngine(joinable, { cookie: 'owner=1' }, { raise: () => Promise.resolve('n') });
        await engine.revoke('conformance-person');
        expect(queued).toHaveLength(1);
        const verdict = await verifyMemberRevocation({
            token: queued[0]?.token ?? '',
            memberKey: publicKey,
            engineId: EngineId.parse(ENGINE_ID),
        });
        expect(verdict).toMatchObject({ kind: 'accepted', revocation: { dashboardUserId: 'conformance-person' } });
    });
});
