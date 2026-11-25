import { afterEach, describe, expect, it } from 'vitest';

import type { ControlServer } from '../src/adapters/control-server';
import type { MockCapabilityName } from '../src/domain/state/capabilities';
import type { ApiHarness } from '../src/testing/api-harness';
import { createApiHarness } from '../src/testing/api-harness';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
    capabilities?: readonly MockCapabilityName[],
): Promise<{ readonly harness: ApiHarness; readonly control: ControlServer }> {
    const harness = await createApiHarness(capabilities === undefined ? {} : { capabilities });
    cleanups.push(() => harness.close());
    return { harness, control: await harness.startControl() };
}

function controlCall(control: ControlServer) {
    return async (path: string, body: unknown) => {
        const response = await fetch(`http://127.0.0.1:${String(control.port)}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
}

describe('AI tool levers on the control listener (M-13)', () => {
    it('expires the sign-in chats run on, renews it, fails checks and answers a device login', async () => {
        const { harness, control } = await setup();
        const call = controlCall(control);
        const controller = () => harness.core().controller;

        const expired = await call('/__mock/ai-tools/expire', {});
        expect(expired).toMatchObject({ status: 200, body: { tool: { id: 'claude-code', status: 'needs-sign-in' } } });
        expect(await call('/__mock/ai-tools/renew', { aiToolId: 'claude-code' })).toMatchObject({
            status: 200,
            body: { tool: { status: 'signed-in' } },
        });

        const failing = await call('/__mock/ai-tools/check-failure', {
            aiToolId: 'codex',
            problem: { code: 'quota-exceeded', message: 'Out of credit.' },
        });
        expect(failing.status).toBe(200);
        expect(failing.body['tools']).toHaveLength(3);
        await call('/__mock/ai-tools/check-failure', { aiToolId: 'codex', problem: null });

        expect((await call('/__mock/ai-tools/device-login', { aiToolId: 'codex', outcome: 'succeeded' })).status).toBe(
            400,
        );
        const owner = harness.client(harness.signIn({ memberId: harness.ownerId() }));
        const started = await owner.aiTools.startSignIn(
            'codex' as never,
            { method: 'account' },
            AbortSignal.timeout(5_000),
        );
        if (started.kind !== 'ok') throw new Error('no sign-in');
        expect((await call('/__mock/ai-tools/device-login', { aiToolId: 'codex', outcome: 'succeeded' })).status).toBe(
            200,
        );
        expect(
            controller()
                .aiTools()
                .find(({ id }) => id === 'codex')?.auth?.method,
        ).toBe('account');

        expect((await call('/__mock/ai-tools/renew', { aiToolId: 'nope' })).status).toBe(404);
        expect((await call('/__mock/ai-tools/expire', { aiToolId: 'gemini-cli' })).status).toBe(400);
        expect((await call('/__mock/ai-tools/expire', { aiToolId: 'claude-code', extra: true })).status).toBe(400);
    });

    it('has nothing to act on without ai-tools@1', async () => {
        const { control } = await setup(['runs']);
        expect(await controlCall(control)('/__mock/ai-tools/expire', {})).toMatchObject({
            status: 404,
            body: { code: 'capability-not-supported' },
        });
    });
});
