import { describe, expect, it } from 'vitest';

import { MOCK_SIGN_IN_ORIGIN, createMockEngineTarget } from './mock-engine';

function targetAnswering(status: number, body: unknown, live = false) {
    const requests: Request[] = [];
    const target = createMockEngineTarget({
        baseUrl: new URL('https://engine.test'),
        controlUrl: new URL('http://127.0.0.1:4480'),
        enginePublicKey: 'key',
        ...(live ? { openLiveChannel: () => Promise.resolve({ kind: 'refused', status: 401 } as const) } : {}),
        fetch: (input, init) => {
            requests.push(new Request(input, init));
            return Promise.resolve(status === 204 ? new Response(null, { status }) : Response.json(body, { status }));
        },
    });
    return { target, requests };
}

describe('createMockEngineTarget', () => {
    it('asks the control listener for the owner or a permission set and returns its cookie', async () => {
        const { target, requests } = targetAnswering(201, {
            memberId: 'member-1',
            cookie: { name: '__Host-ptbk_session', value: 'abc_DEF-123' },
        });
        expect(await target.session({ kind: 'owner' })).toEqual({ cookie: '__Host-ptbk_session=abc_DEF-123' });
        await target.session({ kind: 'member', permissions: ['agents.read'] });
        expect(requests[0]?.url).toBe('http://127.0.0.1:4480/__mock/sessions');
        expect(await requests[0]?.json()).toEqual({ subject: { kind: 'owner' } });
        expect(await requests[1]?.json()).toEqual({ subject: { kind: 'member', permissions: ['agents.read'] } });
        expect(target.enginePublicKey).toBe('key');
        expect(target.memberPrivateResources?.permissions).not.toContain('members.manage');
    });

    it('refuses an error answer and a cookie that could break the header', async () => {
        await expect(targetAnswering(404, {}).target.session({ kind: 'owner' })).rejects.toThrow('answered 404');
        await expect(
            targetAnswering(201, { cookie: { name: 'a', value: 'b; Path=/' } }).target.session({ kind: 'owner' }),
        ).rejects.toThrow('no usable session cookie');
        await expect(targetAnswering(201, {}).target.session({ kind: 'owner' })).rejects.toThrow('no usable');
    });

    it('raises a Wallet request through the control listener', async () => {
        const { target, requests } = targetAnswering(201, { request: { id: 'walletreq-1' } });
        expect(await target.walletRequest?.('https://github.com')).toBe('walletreq-1');
        expect(requests[0]?.url).toBe('http://127.0.0.1:4480/__mock/wallet-requests');
        expect(await requests[0]?.json()).toEqual({ origin: 'https://github.com' });
        await expect(targetAnswering(400, {}).target.walletRequest?.('x')).rejects.toThrow('answered 400');
    });

    it('raises a notification through the control listener', async () => {
        const { target, requests } = targetAnswering(201, { notification: { id: 'notification-1' } });
        const input = { memberId: null, kind: 'tool-sign-in', title: 'Sign in again' } as const;
        expect(await target.notifications?.raise(input)).toBe('notification-1');
        expect(requests[0]?.url).toBe('http://127.0.0.1:4480/__mock/notifications');
        expect(await requests[0]?.json()).toEqual(input);
        await expect(targetAnswering(201, {}).target.notifications?.raise(input)).rejects.toThrow('without an ID');
    });

    it('drives the live browser through the control listener only when it can open the channel', async () => {
        expect(targetAnswering(201, {}).target.liveBrowser).toBeUndefined();
        const tab = targetAnswering(201, { tab: { id: 'tab-1' } }, true);
        const live = tab.target.liveBrowser;
        if (live === undefined) throw new Error('no live browser');
        expect(live.signInOrigin).toBe(MOCK_SIGN_IN_ORIGIN);
        expect(await live.openChannel('session-1', null, 'https://engine.test')).toEqual({
            kind: 'refused',
            status: 401,
        });
        expect(await live.openAgentTab('https://work.conformance.invalid')).toBe('tab-1');
        expect(tab.requests[0]?.url).toBe('http://127.0.0.1:4480/__mock/live-browser/tabs');
        expect(await tab.requests[0]?.json()).toEqual({ origin: 'https://work.conformance.invalid' });

        const help = targetAnswering(201, { request: { id: 'help-1' } }, true);
        expect(await help.target.liveBrowser?.requestHelp('tab-1', 'login', 'Stuck.')).toBe('help-1');
        expect(await help.requests[0]?.json()).toEqual({ tabId: 'tab-1', reason: 'login', message: 'Stuck.' });

        const done = targetAnswering(204, null, true);
        await done.target.liveBrowser?.navigate('tab-1', { kind: 'secret-page' });
        await done.target.liveBrowser?.elapse('session-1', 'idle');
        expect(done.requests.map((request) => new URL(request.url).pathname)).toEqual([
            '/__mock/live-browser/navigate',
            '/__mock/live-browser/elapse',
        ]);
        expect(await done.requests[1]?.json()).toEqual({ sessionId: 'session-1', what: 'idle' });

        await expect(
            targetAnswering(201, {}, true).target.liveBrowser?.openAgentTab('https://x.invalid'),
        ).rejects.toThrow('no tab ID');
        await expect(targetAnswering(404, {}, true).target.liveBrowser?.elapse('session-1', 'expired')).rejects.toThrow(
            'answered 404',
        );
    });

    it('signs in an owner whose passkey assertion is stale', async () => {
        const { target, requests } = targetAnswering(
            201,
            { cookie: { name: '__Host-ptbk_session', value: 'stale' } },
            true,
        );
        expect(await target.liveBrowser?.staleOwnerSession?.()).toEqual({ cookie: '__Host-ptbk_session=stale' });
        expect(await requests[0]?.json()).toEqual({ subject: { kind: 'owner' }, stepUp: 'stale' });
    });
});
