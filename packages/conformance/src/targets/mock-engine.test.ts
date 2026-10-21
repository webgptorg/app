import { describe, expect, it } from 'vitest';

import { createMockEngineTarget } from './mock-engine';

function targetAnswering(status: number, body: unknown) {
    const requests: Request[] = [];
    const target = createMockEngineTarget({
        baseUrl: new URL('https://engine.test'),
        controlUrl: new URL('http://127.0.0.1:4480'),
        enginePublicKey: 'key',
        fetch: (input, init) => {
            requests.push(new Request(input, init));
            return Promise.resolve(Response.json(body, { status }));
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
});
