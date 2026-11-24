import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../check';
import { runConformance } from '../../runner';
import type { ConformanceTarget } from '../../target';
import type { FakeEngineOptions, Tamper } from '../../testing/fake-engine';
import { createFakeEngine } from '../../testing/fake-engine';
import { ENGINE_API_SUITE } from './index';

const CHECKS = {
    check: 'engine-api.ai-tools.check',
    permissions: 'engine-api.ai-tools.permissions',
    flow: 'engine-api.ai-tools.sign-in-flow',
    secret: 'engine-api.ai-tools.secret-never-echoed',
    required: 'engine-api.ai-tools.sign-in-required',
} as const;

async function outcome(
    id: string,
    options: FakeEngineOptions = {},
    adjust: (target: ConformanceTarget) => ConformanceTarget = (target) => target,
): Promise<CheckOutcome> {
    const fake = await createFakeEngine(options);
    const report = await runConformance({
        target: adjust(fake.target),
        suites: [ENGINE_API_SUITE],
        filter: (check) => check.id === id,
        timeoutMs: 30_000,
        signal: AbortSignal.timeout(60_000),
        seed: 7,
    });
    const result = report.results.find((candidate) => candidate.id === id);
    if (!result) throw new Error(`no result for ${id}`);
    return result.outcome;
}

const path = (request: Request): string => new URL(request.url).pathname.slice('/api/v1'.length);
const TOOL = /^\/ai-tools\/[^/]+$/;
const CHECK = /^\/ai-tools\/[^/]+\/check$/;
const SIGN_INS = /^\/ai-tools\/[^/]+\/sign-ins$/;
const SIGN_IN = /^\/ai-tools\/[^/]+\/sign-ins\/[^/]+$/;
const ANSWER = /^\/ai-tools\/[^/]+\/sign-ins\/[^/]+\/answer$/;
const CHAT = /^\/chats\/[^/]+$/;

const on = (method: string, pattern: RegExp) => (request: Request) =>
    request.method === method && pattern.test(path(request));

function problem(code: string, status: number, extra: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({ type: 'https://ptbk.io/problems/x', title: 'X', status, code, ...extra }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
    });
}

const TOOL_JSON = {
    id: 'claude-code',
    name: 'Claude Code',
    version: '2.1.330',
    auth: { method: 'account', account: 'Claude Max' },
    signInMethods: ['account', 'api-key'],
    checkedAt: '2020-01-01T00:00:00Z',
    checking: false,
    status: 'signed-in',
    problem: null,
};

const SIGN_IN_JSON = {
    id: 'forged',
    aiToolId: 'claude-code',
    method: 'account',
    status: 'completed',
    activity: [],
    expiresAt: '2030-01-01T00:00:00Z',
    prompt: null,
    tool: TOOL_JSON,
};

/** Replaces the answer to matching requests whose original answer had `status`. */
function when(
    match: (request: Request) => boolean,
    status: number,
    make: (request: Request, response: Response) => Response | Promise<Response>,
): Tamper {
    return (request, response) => (match(request) && response.status === status ? make(request, response) : response);
}

/** Rewrites the JSON of matching successful answers. */
function rewrite(
    match: (request: Request) => boolean,
    change: (
        data: Record<string, unknown>,
        request: Request,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Tamper {
    return async (request, response) => {
        if (!match(request) || response.status >= 300) return response;
        const data = (await response.json()) as Record<string, unknown>;
        return Response.json(await change(data, request), { status: response.status });
    };
}

async function answeredSecret(request: Request): Promise<string | null> {
    const body = (await request.clone().json()) as { answer?: { kind?: string; value?: string } };
    return body.answer?.kind === 'secret' ? (body.answer.value ?? null) : null;
}

/** Remembers the key sent in an answer and puts it into the audit log's user agents. */
function keyInAudit(): Tamper {
    let key: string | null = null;
    return async (request, response) => {
        if (on('POST', ANSWER)(request)) key ??= await answeredSecret(request);
        if (key === null || request.method !== 'GET' || path(request) !== '/audit') return response;
        const page = (await response.json()) as { items: { client: { userAgent: string } | null }[] };
        const leaked = key;
        return Response.json({
            ...page,
            items: page.items.map((entry) =>
                entry.client === null ? entry : { ...entry, client: { ...entry.client, userAgent: leaked } },
            ),
        });
    };
}

/** Once a matching request was answered with `status`, `then` tampers with everything after it. */
function after(match: (request: Request) => boolean, status: number, then: Tamper): Tamper {
    let seen = false;
    return async (request, response) => {
        if (seen) return then(request, response);
        if (match(request) && response.status === status) seen = true;
        return response;
    };
}

/** The tool now reads as using an API key, whatever the engine says. */
const keyedTool = rewrite(on('GET', TOOL), (data) => ({ ...data, auth: { method: 'api-key', account: null } }));

const NO_TOOLS = rewrite(on('GET', /^\/ai-tools$/), () => ({ items: [] }));

const NO_AI_TOOLS = Object.values(KNOWN_CAPABILITIES).filter((ref) => ref !== KNOWN_CAPABILITIES.aiTools);

describe('the AI tool checks', () => {
    it.each(Object.values(CHECKS))('pass against the in-memory engine: %s', async (id) => {
        expect(await outcome(id)).toEqual({ kind: 'pass' });
    });

    it.each(Object.values(CHECKS))('skip without the capability: %s', async (id) => {
        expect(await outcome(id, { capabilities: NO_AI_TOOLS })).toEqual({
            kind: 'skip',
            reason: 'capability-not-advertised',
        });
    });

    it.each([CHECKS.check, CHECKS.permissions, CHECKS.flow, CHECKS.secret])(
        'skip when the engine lists no AI tool: %s',
        async (id) => {
            expect((await outcome(id, { tamper: NO_TOOLS })).kind).toBe('skip');
        },
    );

    it('skip the sign-in flow when the engine wants a fresh step-up', async () => {
        const tamper = when(on('POST', SIGN_INS), 201, () => problem('step-up-required', 401));
        expect((await outcome(CHECKS.flow, { tamper })).kind).toBe('skip');
    });

    it('pass the secret check without audit@1, reading no audit log', async () => {
        const capabilities = Object.values(KNOWN_CAPABILITIES).filter((ref) => ref !== KNOWN_CAPABILITIES.audit);
        expect(await outcome(CHECKS.secret, { capabilities })).toEqual({ kind: 'pass' });
    });

    it('fail the sign-in-required check when the lever expires nothing and the agent answers', async () => {
        expect(
            await outcome(CHECKS.required, {}, (target) => ({
                ...target,
                aiTools: {
                    expireSignIn: () => Promise.resolve('claude-code'),
                    renewSignIn: () => Promise.resolve(),
                },
            })),
        ).toMatchObject({ kind: 'fail' });
    });

    it('skip the sign-in-required check without the target levers', async () => {
        expect(
            await outcome(CHECKS.required, {}, (target) => {
                const rest: ConformanceTarget = { ...target };
                delete (rest as { aiTools?: unknown }).aiTools;
                return rest;
            }),
        ).toMatchObject({ kind: 'skip' });
    });

    const fails: readonly [name: string, id: string, tamper: Tamper][] = [
        [
            'a tool that reads as another one by ID',
            CHECKS.check,
            rewrite(on('GET', TOOL), (data) => ({ ...data, name: 'Something else' })),
        ],
        [
            'a check of a tool that is not installed accepted',
            CHECKS.check,
            when(on('POST', CHECK), 409, () => Response.json(TOOL_JSON, { status: 202 })),
        ],
        [
            'a check that leaves checkedAt where it was',
            CHECKS.check,
            rewrite(on('POST', CHECK), (data) => ({ ...data, checkedAt: '2020-01-01T00:00:00Z' })),
        ],
        [
            'tools listed to a member without ai-tools.read',
            CHECKS.permissions,
            when(on('GET', /^\/ai-tools$/), 403, () => Response.json({ items: [] })),
        ],
        [
            'a refusal naming another permission',
            CHECKS.permissions,
            when(on('POST', SIGN_INS), 403, () => problem('forbidden', 403, { requiredPermission: 'ai-tools.read' })),
        ],
        [
            'a sign-in that offers Back',
            CHECKS.flow,
            rewrite(on('POST', SIGN_INS), (data) => ({
                ...data,
                prompt: { ...(data['prompt'] as Record<string, unknown>), canGoBack: true },
            })),
        ],
        [
            'a sign-in readable after it was cancelled or from another session',
            CHECKS.flow,
            when(on('GET', SIGN_IN), 404, () => Response.json(SIGN_IN_JSON)),
        ],
        ['a stale answer accepted', CHECKS.flow, when(on('POST', ANSWER), 409, () => Response.json(SIGN_IN_JSON))],
        [
            'an answer of the wrong kind accepted',
            CHECKS.flow,
            when(on('POST', ANSWER), 400, () => Response.json(SIGN_IN_JSON)),
        ],
        ['a cancel that answers 200', CHECKS.flow, when(on('DELETE', SIGN_IN), 204, () => Response.json({}))],
        ['a made-up key accepted', CHECKS.secret, when(on('POST', ANSWER), 200, () => Response.json(SIGN_IN_JSON))],
        [
            'a refused key echoed in the prompt',
            CHECKS.secret,
            rewrite(on('POST', ANSWER), async (data, request) => ({
                ...data,
                prompt: {
                    ...(data['prompt'] as Record<string, unknown>),
                    error: `Refused: ${(await answeredSecret(request)) ?? ''}`,
                },
            })),
        ],
        [
            'a refused key that keeps its prompt',
            CHECKS.secret,
            rewrite(on('POST', ANSWER), async (data, request) => ({
                ...data,
                prompt: {
                    ...(data['prompt'] as Record<string, unknown>),
                    id: ((await request.clone().json()) as { promptId: string }).promptId,
                },
            })),
        ],
        ['the key in the audit log', CHECKS.secret, keyInAudit()],
        [
            'a tool that is not installed yet offers a sign-in',
            CHECKS.check,
            rewrite(on('GET', /^\/ai-tools$/), (data) => ({
                items: (data['items'] as Record<string, unknown>[]).map((tool) =>
                    tool['status'] === 'not-installed' ? { ...tool, signInMethods: ['account'] } : tool,
                ),
            })),
        ],
        [
            'every tool listed as not installed, yet checkable',
            CHECKS.check,
            rewrite(on('GET', /^\/ai-tools$/), (data) => ({
                items: (data['items'] as Record<string, unknown>[]).map((tool) => ({
                    ...tool,
                    status: 'not-installed',
                    signInMethods: [],
                    problem: { code: 'not-installed', message: 'Not here.' },
                })),
            })),
        ],
        [
            'a refusal naming no permission',
            CHECKS.permissions,
            when(on('POST', SIGN_INS), 403, () => problem('forbidden', 403)),
        ],
        [
            'a refused sign-out that still changes the credentials',
            CHECKS.permissions,
            after(on('DELETE', /^\/ai-tools\/[^/]+\/credentials$/), 403, keyedTool),
        ],
        [
            'a sign-in that fails to start',
            CHECKS.flow,
            when(on('POST', SIGN_INS), 201, () => problem('internal-error', 500)),
        ],
        [
            'a new sign-in that is already completed',
            CHECKS.flow,
            rewrite(on('POST', SIGN_INS), (data) => ({ ...data, status: 'completed', prompt: null })),
        ],
        [
            'a sign-in that shows another prompt when read again',
            CHECKS.flow,
            rewrite(on('GET', SIGN_IN), (data) => ({
                ...data,
                prompt: { ...(data['prompt'] as Record<string, unknown>), id: 'another-prompt' },
            })),
        ],
        [
            'an unfinished sign-in that changes the credentials',
            CHECKS.flow,
            after(on('POST', SIGN_INS), 201, keyedTool),
        ],
        [
            'an API key sign-in without a secret prompt',
            CHECKS.secret,
            rewrite(on('POST', SIGN_INS), (data) => ({ ...data, status: 'completed', prompt: null })),
        ],
        [
            'a refused key without an error',
            CHECKS.secret,
            rewrite(on('POST', ANSWER), (data) => ({
                ...data,
                prompt: { ...(data['prompt'] as Record<string, unknown>), error: null },
            })),
        ],
        [
            'a refused key that changes the credentials',
            CHECKS.secret,
            after(
                on('POST', ANSWER),
                200,
                rewrite(on('GET', TOOL), (data) => ({ ...data, auth: { method: 'account', account: 'Someone' } })),
            ),
        ],
        [
            'an expired sign-in that reads signed in',
            CHECKS.required,
            rewrite(on('GET', TOOL), (data) => ({ ...data, status: 'signed-in', problem: null })),
        ],
        [
            'a failed turn that names no tool',
            CHECKS.required,
            rewrite(on('GET', CHAT), (data) =>
                data['recheck'] === null
                    ? data
                    : { ...data, recheck: { ...(data['recheck'] as Record<string, unknown>), aiToolId: null } },
            ),
        ],
    ];

    it.each(fails)('fail on %s', async (_, id, tamper) => {
        expect((await outcome(id, { tamper })).kind).toBe('fail');
    });
});
