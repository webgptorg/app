import { JOIN_OPTIONS_PATH, JOIN_STATUS_PATH, JOIN_VERIFY_PATH } from '@ptbk/engine-api';
import { createWebCryptoSigner, generateEd25519KeyPair } from '@ptbk/protocol';
import type { EngineId } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { SessionCredential } from '../../../src/index';
import type { JoinCheck, JoinableEngine } from './join';
import {
    expiredTicketRefused,
    forgedTicketRefused,
    lastOwnerRefused,
    otherEngineTicketRefused,
    pendingCapEnforced,
    replayedTicketRefused,
    revocationRevokes,
    switchedOffRefused,
    wrongCodeRefused,
} from './join';

const OPTIONS = { options: { challenge: 'Y2hhbGxlbmdl', rp: { id: 'engine.localhost' } } };
const JOINED = { request: 'request-1', code: '123456' };
const API = '/api/v1';

type Answer = readonly [status: number, body?: unknown];
/** Answers per `METHOD path`; a list is consumed in order, its last answer repeating. */
type Script = Record<string, Answer | readonly Answer[]>;

const isList = (answer: Answer | readonly Answer[]): answer is readonly Answer[] => Array.isArray(answer[0]);

interface Options {
    readonly session?: SessionCredential | null;
    readonly engineId?: string;
    readonly ack?: string;
}

/** An engine that answers from a script and acks each revocation with `ack`: each rule is run on the defect alone. */
async function scripted(script: Script, { session = { cookie: 's=1' }, engineId, ack }: Options = {}) {
    const requests: { path: string; headers: Headers }[] = [];
    const replies = new Map<string, number>();
    const heartbeats: unknown[] = [];
    const signer = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
    const dashboard = {
        memberSigner: signer,
        heartbeats,
        queueRevocation(_engine: EngineId, id: string) {
            heartbeats.push({
                at: Date.now(),
                verification: { kind: 'accepted', heartbeat: { v: 2, acks: [{ id, outcome: ack }] } },
            });
        },
        waitFor: (select: () => unknown) => {
            const found = select();
            return found === undefined ? Promise.reject(new Error(`unacked`)) : Promise.resolve(found);
        },
    };
    const endpoint = {
        baseUrl: new URL('https://engine.localhost'),
        fetch: (input: URL, init: RequestInit) => {
            const key = `${String(init.method)} ${input.pathname}`;
            requests.push({ path: key, headers: new Headers(init.headers) });
            const configured = script[key];
            if (configured === undefined) return Promise.resolve(new Response('<html>', { status: 599 }));
            const count = replies.get(key) ?? 0;
            replies.set(key, count + 1);
            const [status, body] = isList(configured)
                ? (configured[Math.min(count, configured.length - 1)] as Answer)
                : configured;
            return Promise.resolve(Response.json(body ?? {}, { status }));
        },
    };
    const ctx = {
        random: { bytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)) },
        signal: new AbortController().signal,
        expectations: { heartbeatIntervalMs: 1000, startTimeoutMs: 1000 },
        engineTarget: () => (session === null ? null : { session: () => Promise.resolve(session) }),
    };
    const engine = {
        registered: { dashboard, engine: { waitForExit: () => Promise.resolve(null) } },
        endpoint,
        engineId: engineId ?? 'a'.repeat(26),
        ctx,
    } as unknown as JoinableEngine;
    return { engine, requests };
}

const options = `POST ${JOIN_OPTIONS_PATH}`;
const verify = `POST ${JOIN_VERIFY_PATH}`;
const status = `POST ${JOIN_STATUS_PATH}`;
const list = `GET ${API}/access-requests`;
const approve = `POST ${API}/access-requests/r1/approve`;
const me = `GET ${API}/me`;
const stepDown = `PATCH ${API}/members/m1`;
const removals = `PUT ${API}/settings/dashboard-removals`;

const joins: Script = { [options]: [200, OPTIONS], [verify]: [201, JOINED] };
const pending: Answer = [200, { items: [{ id: 'r1' }] }];

async function detail(check: JoinCheck, script: Script, settings?: Options): Promise<unknown> {
    const { engine } = await scripted(script, settings);
    const outcome = await check.against(engine);
    if (outcome.kind === 'pass') return 'pass';
    return outcome.kind === 'fail' ? outcome.detail : outcome.reason;
}

describe('the join checks fail an engine that breaks their rule', () => {
    it.each<[string, JoinCheck, Script, string]>([
        ['accepts a forged ticket', forgedTicketRefused, joins, 'expected 403 ticket-invalid, got 200'],
        ['accepts another engine’s ticket', otherEngineTicketRefused, joins, 'expected 403 ticket-invalid, got 200'],
        ['accepts an expired ticket', expiredTicketRefused, joins, 'expected 403 ticket-expired, got 200'],
        ['accepts a replayed ticket', replayedTicketRefused, joins, 'expected 409 ticket-used, got 200'],
        [
            'refuses the first use of a ticket',
            replayedTicketRefused,
            { [options]: [403, { code: 'ticket-invalid' }] },
            'the join failed: 403 ticket-invalid',
        ],
        [
            'shows a code that is not 6 digits',
            replayedTicketRefused,
            { ...joins, [verify]: [201, { request: 'r', code: '12' }] },
            'not 6 digits',
        ],
        ['verifies without a code', replayedTicketRefused, { ...joins, [verify]: [201, {}] }, 'the join failed: 201'],
        ['has no cap on pending requests', pendingCapEnforced, joins, 'expected 409 too-many-requests, got 200'],
        ['refuses a request under the cap', pendingCapEnforced, { [options]: [500] }, 'request 1 failed: 500'],
        [
            'approves with a wrong code',
            wrongCodeRefused,
            { ...joins, [list]: pending, [approve]: [201] },
            'a wrong code answered 201',
        ],
        ['does not list the request', wrongCodeRefused, { ...joins, [list]: [200, {}] }, 'answered no request'],
        [
            'refuses the right code',
            wrongCodeRefused,
            { ...joins, [list]: pending, [approve]: [422, { code: 'access-code-mismatch' }] },
            'the right code answered 422 access-code-mismatch',
        ],
        [
            'never tells the waiting page',
            wrongCodeRefused,
            {
                ...joins,
                [list]: pending,
                [approve]: [[422, { code: 'access-code-mismatch' }], [201]],
                [status]: [200, { state: 'pending' }],
            },
            'status answered 200',
        ],
        ['fails the join', wrongCodeRefused, { [options]: [500] }, 'the join failed: 500'],
        ['fails the join before a revocation', revocationRevokes, {}, 'the join failed: 599'],
        ['fails the approval before a revocation', revocationRevokes, joins, 'approving the request failed'],
        ['has no /me', lastOwnerRefused, {}, 'GET /me answered 599'],
        ['cannot switch removals off', switchedOffRefused, {}, 'switching removals off answered 599'],
    ])('an engine that %s', async (_name, check, script, expected) => {
        expect(await detail(check, script)).toContain(expected);
    });

    const revokes: Script = { ...joins, [list]: pending, [approve]: [201] };

    it('reports an ack that says something else', async () => {
        expect(await detail(revocationRevokes, revokes, { ack: 'not-found' })).toBe(
            'the ack says not-found, not revoked',
        );
    });

    it('passes the ack the rule asks for', async () => {
        expect(await detail(revocationRevokes, revokes, { ack: 'revoked' })).toBe('pass');
        expect(
            await detail(
                switchedOffRefused,
                { ...revokes, [removals]: [200] },
                {
                    ack: 'refused-disabled',
                },
            ),
        ).toBe('pass');
    });

    it('skips, rather than fails, the last owner rule when the owner cannot step down', async () => {
        const script = { ...revokes, [me]: [200, { memberId: 'm1' }], [stepDown]: [403] } as Script;
        expect(await detail(lastOwnerRefused, script)).toBe('the original owner could not step down: 403');
        expect(await detail(lastOwnerRefused, { ...script, [stepDown]: [200] }, { ack: 'refused-owner' })).toBe('pass');
    });

    it('skips what needs an owner when the run has no session for the engine', async () => {
        for (const check of [wrongCodeRefused, revocationRevokes, lastOwnerRefused, switchedOffRefused]) {
            expect(await detail(check, {}, { session: null })).toContain('no owner session');
        }
    });

    it('sends the session it has, as a cookie or a bearer token', async () => {
        for (const [session, header, value] of [
            [{ cookie: 's=1' }, 'cookie', 's=1'],
            [{ bearer: 'token' }, 'authorization', 'Bearer token'],
        ] as const) {
            const { engine, requests } = await scripted({}, { session });
            await switchedOffRefused.against(engine);
            expect(requests[0]?.headers.get(header)).toBe(value);
        }
    });

    it('asks for a ticket of another engine whatever this engine’s ID starts with', async () => {
        const { engine } = await scripted(
            { [options]: [403, { code: 'ticket-invalid' }] },
            { engineId: 'b'.repeat(26) },
        );
        expect((await otherEngineTicketRefused.against(engine)).kind).toBe('pass');
    });
});
