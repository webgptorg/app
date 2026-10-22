import { describe, expect, it } from 'vitest';

import { ControlError, cookieFromCredential, createMockEngineUiTarget } from './mock-engine-target.ts';

interface Call {
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
}

function fakeControl(answers: Readonly<Record<string, { status: number; body?: unknown }>>) {
    const calls: Call[] = [];
    const fetch = ((input: URL | string, init?: RequestInit) => {
        const url = new URL(input);
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path: url.pathname,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        const answer = answers[`${method} ${url.pathname}`] ?? { status: 404 };
        return Promise.resolve(
            new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status }),
        );
    }) as typeof globalThis.fetch;
    const target = createMockEngineUiTarget({
        hostname: 'abc.engine.test',
        controlUrl: new URL('http://10.0.0.1:4480'),
        tamperedVersion: '0.0.0-dryrun.2',
        fetch,
    });
    return { target, calls };
}

const COOKIE = { cookie: { name: '__Host-ptbk_session', value: 'tok' } };

describe('createMockEngineUiTarget', () => {
    it('signs in the owner, a role and a permission set through the control listener', async () => {
        const { target, calls } = fakeControl({ 'POST /__mock/sessions': { status: 201, body: COOKIE } });
        for (const subject of [
            { kind: 'owner' },
            { kind: 'member', role: 'viewer' },
            { kind: 'member', permissions: ['agents.read'] },
        ] as const) {
            expect(await target.session(subject)).toEqual({ name: '__Host-ptbk_session', value: 'tok' });
        }
        expect(calls.map((call) => call.body)).toEqual([
            { subject: { kind: 'owner' } },
            { subject: { kind: 'member', role: 'viewer' } },
            { subject: { kind: 'member', permissions: ['agents.read'] } },
        ]);
    });

    it('drives the controls with strict bodies and reads their answers', async () => {
        const { target, calls } = fakeControl({
            'POST /__mock/reset': { status: 200, body: {} },
            'PUT /__mock/faults': { status: 200, body: {} },
            'DELETE /__mock/faults': { status: 204 },
            'POST /__mock/simulation': { status: 200, body: {} },
            'POST /__mock/simulation/advance': { status: 200, body: {} },
            'POST /__mock/runs': { status: 201, body: { id: 'run-1' } },
            'POST /__mock/inbound-email': { status: 201, body: { fire: { runId: 'run-2' } } },
            'POST /__mock/ui/check': {
                status: 200,
                body: { outcome: { kind: 'refused', reason: 'hash-mismatch' }, active: { version: '0.0.0-dryrun.1' } },
            },
            'GET /__mock/heartbeat': { status: 200, body: { lastHeartbeat: null, clockSkew: null } },
        });
        const { controls } = target;
        await controls.reset?.({ scenario: 'small-team', seed: 1, capabilities: ['runs'] });
        await controls.faults?.set({ errorRate: 1 });
        await controls.faults?.clear();
        await controls.pauseSimulation?.();
        await controls.advanceTime?.(1000);
        expect(await controls.scriptRun?.({ agentId: 'a', outcome: 'completed', steps: [{ text: 'x' }] })).toEqual({
            runId: 'run-1',
        });
        expect(await controls.inboundEmail?.({ triggerId: 't', from: 'a@example.com', subject: 's' })).toEqual({
            runId: 'run-2',
        });
        expect(await controls.tamperBundle?.()).toEqual({
            refused: true,
            reason: 'hash-mismatch',
            activeVersion: '0.0.0-dryrun.1',
        });
        expect(await controls.lastHeartbeat?.()).toBeNull();
        expect(calls.find((call) => call.path === '/__mock/reset')?.body).toEqual({
            scenario: 'small-team',
            seed: 1,
            capabilities: ['runs'],
        });
        expect(calls.find((call) => call.path === '/__mock/ui/check')?.body).toEqual({
            pinnedVersion: '0.0.0-dryrun.2',
        });
    });

    it('fails loudly when the control listener refuses', async () => {
        const { target } = fakeControl({});
        await expect(target.controls.advanceTime?.(1)).rejects.toBeInstanceOf(ControlError);
    });
});

describe('cookieFromCredential', () => {
    it('splits one cookie and refuses anything else', () => {
        expect(cookieFromCredential({ cookie: 'a=b' })).toEqual({ name: 'a', value: 'b' });
        expect(() => cookieFromCredential({ cookie: 'a=b; c=d' })).toThrow();
        expect(() => cookieFromCredential({ bearer: 'x' })).toThrow();
        expect(() => cookieFromCredential(null)).toThrow();
    });
});
