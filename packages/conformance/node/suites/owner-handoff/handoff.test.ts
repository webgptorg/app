import { OwnerSetupSecret, ownerSetupCommitment } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { HandoffCheck, HandoffEngine, UncommittedEngine } from './handoff';
import {
    SIGNAL_MAX_DELAY_MS,
    ownerSpendsBoth,
    secretAccepted,
    setupAudited,
    signalAbsentAgainst,
    signalPrompt,
} from './handoff';

const SECRET = OwnerSetupSecret.parse('AAECAwQFBgcICQoLDA0ODw');
const OPTIONS = { options: { challenge: 'Y2hhbGxlbmdl', rp: { id: 'engine.localhost' } } };

type Defect =
    | 'accepts-wrong'
    | 'accepts-commitment'
    | 'refuses-secret'
    | 'reuses-secret'
    | 'keeps-signal'
    | 'signals-after-restart'
    | 'audit-unmarked'
    | 'no-session'
    | 'signals-without-commitment';

interface Beat {
    readonly at: number;
    readonly verification: { readonly kind: 'accepted'; readonly heartbeat: { readonly ownerHandoff?: 'ready' } };
    readonly answer: { readonly status: number };
}

const problem = (status: number, code: string) => Response.json({ code }, { status });

/**
 * An engine that answers the setup endpoints and beats from its state, broken by `defects`. Its dashboard adds the
 * next beat whenever a check waits for one, so no check ever sleeps.
 */
async function scripted(defects: readonly Defect[] = [], { delayMs = 0, committed = true } = {}) {
    const broken = new Set(defects);
    const commitment = await ownerSetupCommitment(SECRET);
    let owner = false;
    let restarted = false;
    const heartbeats: Beat[] = [];
    const signalling = (): boolean =>
        broken.has('signals-without-commitment') ||
        (committed && !owner) ||
        (committed && broken.has('keeps-signal') && !restarted) ||
        (committed && broken.has('signals-after-restart') && restarted);
    const beat = (): Beat => {
        const entry: Beat = {
            at: Date.now(),
            verification: { kind: 'accepted', heartbeat: signalling() ? { ownerHandoff: 'ready' } : {} },
            answer: { status: 204 },
        };
        heartbeats.push(entry);
        return entry;
    };
    const dashboard = {
        heartbeats,
        waitFor: (select: () => unknown) => {
            for (let attempt = 0; attempt < 4; attempt++) {
                const found = select();
                if (found !== undefined) return Promise.resolve(found);
                beat();
            }
            return Promise.reject(new Error('nothing matched'));
        },
    };
    const accepts = (secret: unknown): boolean =>
        (secret === SECRET && !broken.has('refuses-secret')) ||
        broken.has('accepts-wrong') ||
        (secret === commitment && broken.has('accepts-commitment'));
    const endpoint = {
        baseUrl: new URL('https://engine.localhost'),
        fetch: async (input: URL, init: RequestInit) => {
            const key = `${String(init.method)} ${input.pathname}`;
            const body = (typeof init.body === 'string' ? JSON.parse(init.body) : {}) as { secret?: unknown };
            switch (key) {
                case 'POST /setup/options':
                    if (owner && !broken.has('reuses-secret')) return problem(409, 'owner-exists');
                    return accepts(body.secret) ? Response.json(OPTIONS) : problem(403, 'setup-link-invalid');
                case 'POST /setup/verify':
                    if (owner) return problem(409, 'owner-exists');
                    if (!accepts(body.secret)) return problem(403, 'setup-link-invalid');
                    owner = true;
                    return Response.json(
                        { next: '/' },
                        broken.has('no-session') ? {} : { headers: { 'Set-Cookie': '__Host-s=1; Secure; HttpOnly' } },
                    );
                case 'GET /api/v1/audit': {
                    if (new Headers(init.headers).get('cookie') !== '__Host-s=1')
                        return problem(401, 'unauthenticated');
                    const details = broken.has('audit-unmarked') ? null : { via: 'owner-handoff' };
                    return Response.json({ items: [{ action: 'passkey.register', details }], nextCursor: null });
                }
                default:
                    return Promise.resolve(new Response('<html>', { status: 599 }));
            }
        },
    };
    const ctx = {
        random: { bytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)) },
        signal: new AbortController().signal,
        expectations: { heartbeatIntervalMs: 1000, startTimeoutMs: 1000 },
    };
    const servedAt = Date.now();
    const registered = {
        dashboard,
        engine: { waitForExit: () => Promise.resolve(null) },
        restart: () => {
            restarted = true;
            beat();
            return Promise.resolve();
        },
    };
    const ready = { ...beat(), at: servedAt + delayMs };
    const engine = {
        registered,
        endpoint,
        secret: SECRET,
        ctx,
        servedAt,
        ready,
    } as unknown as HandoffEngine;
    return { engine, uncommitted: { registered, servedAt, ctx } as unknown as UncommittedEngine };
}

async function detail(check: HandoffCheck, defects: readonly Defect[] = [], delayMs = 0): Promise<string> {
    const { engine } = await scripted(defects, { delayMs });
    const outcome = await check.against(engine);
    if (outcome.kind === 'pass') return 'pass';
    return outcome.kind === 'fail' ? outcome.detail : outcome.reason;
}

describe('the owner-handoff checks pass an engine that keeps their rules', () => {
    it.each([signalPrompt, secretAccepted, ownerSpendsBoth, setupAudited])('$id', async (check) => {
        expect(await detail(check)).toBe('pass');
    });

    it('passes an engine registered without a commitment that never signals', async () => {
        const { uncommitted } = await scripted([], { committed: false });
        expect(await signalAbsentAgainst(uncommitted)).toEqual({ kind: 'pass' });
    });
});

describe('the owner-handoff checks fail an engine that breaks their rule', () => {
    it('fails a signal that comes a heartbeat interval after /setup is served', async () => {
        expect(await detail(signalPrompt, [], SIGNAL_MAX_DELAY_MS + 50_000)).toContain('after /setup was served');
    });

    it.each([
        ['accepts any secret', 'accepts-wrong', 'a wrong secret'],
        ['accepts the commitment as the secret', 'accepts-commitment', 'the commitment instead of the secret'],
        ['refuses the handoff secret', 'refuses-secret', 'the handoff secret'],
    ] as const)('fails an engine that %s', async (_name, defect, expected) => {
        expect(await detail(secretAccepted, [defect])).toContain(expected);
    });

    it.each([
        ['takes the secret again after setup', 'reuses-secret', 'expected 409 owner-exists'],
        ['keeps signalling after setup', 'keeps-signal', 'after setup still carry ownerHandoff'],
        ['signals again after a restart', 'signals-after-restart', 'after a restart with an owner'],
        ['refuses the secret', 'refuses-secret', 'setup with the secret'],
    ] as const)('fails an engine that %s', async (_name, defect, expected) => {
        expect(await detail(ownerSpendsBoth, [defect])).toContain(expected);
    });

    it.each([
        ['does not mark the audit entry', 'audit-unmarked', 'marked as the handoff'],
        ['gives no session after setup', 'no-session', 'gave no session'],
    ] as const)('fails an engine that %s', async (_name, defect, expected) => {
        expect(await detail(setupAudited, [defect])).toContain(expected);
    });

    it('fails an engine that signals without a commitment', async () => {
        const { uncommitted } = await scripted(['signals-without-commitment'], { committed: false });
        const outcome = await signalAbsentAgainst(uncommitted);
        expect(outcome.kind === 'fail' && outcome.detail).toContain('without a commitment sent ownerHandoff');
    });
});
