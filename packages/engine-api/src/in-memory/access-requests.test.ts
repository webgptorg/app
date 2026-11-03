import { describe, expect, it } from 'vitest';

import { MAX_PENDING_ACCESS_REQUESTS } from '../capabilities/access-requests';
import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import type { EngineApiResponse } from '../client';
import { AccessRequestId, MemberId } from '../common';
import { createInMemoryEngine } from '../in-memory-client';
import type { InMemoryEngineApiOptions } from '../in-memory-client';
import { ENGINE_API_ROUTES } from '../routes';

const AT = '2026-10-30T08:00:00Z';
const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function code(response: EngineApiResponse<unknown>): string {
    return response.kind === 'problem' ? response.problem.code : 'ok';
}

function engineAt(at = AT, options: InMemoryEngineApiOptions = {}) {
    let now = Date.parse(at);
    const engine = createInMemoryEngine({ ...options, clock: { now: () => new Date(now) } });
    return {
        ...engine,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

const petr = { dashboardUserId: 'user-petr', displayName: 'Petr', email: 'petr@example.com', code: '482913' };

describe('access requests', () => {
    it('lists a pending request without its code and approves it into a member with the dashboard user ID', async () => {
        const { client, controller } = engineAt();
        const request = controller.requestAccess({ ...petr, proposedRole: 'member' });
        const listed = ok(await client.members.listAccessRequests({}, signal())).items;
        expect(listed).toEqual([request]);
        expect(JSON.stringify(listed)).not.toContain(petr.code);

        const member = ok(
            await client.members.approveAccessRequest(request.id, { code: '482913', role: 'admin' }, signal()),
        );
        expect(member).toMatchObject({ displayName: 'Petr', role: 'admin', status: 'active', passkeyCount: 1 });
        expect(member.dashboardUserId).toBe('user-petr');
        expect(ok(await client.members.listAccessRequests({}, signal())).items).toEqual([]);
        expect(ok(await client.passkeys.list({ memberId: member.id }, signal())).items).toHaveLength(1);
    });

    it('refuses a wrong code and keeps the request; declining discards it', async () => {
        const { client, controller } = engineAt();
        const request = controller.requestAccess({ ...petr, proposedRole: 'member' });
        const wrong = await client.members.approveAccessRequest(
            request.id,
            { code: '000000', role: 'member' },
            signal(),
        );
        expect(code(wrong)).toBe('access-code-mismatch');
        expect(ok(await client.members.listAccessRequests({}, signal())).items).toHaveLength(1);

        expect(code(await client.members.declineAccessRequest(request.id, signal()))).toBe('ok');
        expect(code(await client.members.declineAccessRequest(request.id, signal()))).toBe('not-found');
        const gone = await client.members.approveAccessRequest(
            request.id,
            { code: petr.code, role: 'member' },
            signal(),
        );
        expect(code(gone)).toBe('not-found');
    });

    it('rejects a malformed code before the engine sees it', async () => {
        const { client } = engineAt();
        const id = AccessRequestId.parse('access-x');
        expect(code(await client.members.approveAccessRequest(id, { code: '12345', role: 'member' }, signal()))).toBe(
            'validation-failed',
        );
    });

    it('drops requests after seven days and caps how many wait', async () => {
        const { client, controller, advance } = engineAt();
        controller.requestAccess({ ...petr, proposedRole: 'member' });
        advance(7 * 24 * 60 * 60 * 1000);
        expect(ok(await client.members.listAccessRequests({}, signal())).items).toEqual([]);

        for (let index = 0; index < MAX_PENDING_ACCESS_REQUESTS; index++) {
            controller.requestAccess({ ...petr, dashboardUserId: `user-${String(index)}`, proposedRole: 'member' });
        }
        expect(() =>
            controller.requestAccess({ ...petr, dashboardUserId: 'user-late', proposedRole: 'member' }),
        ).toThrow(/too many/);
        // A person already waiting may still replace their own request at the cap.
        controller.requestAccess({ ...petr, dashboardUserId: 'user-0', proposedRole: 'admin' });
        expect(ok(await client.members.listAccessRequests({ limit: 100 }, signal())).items).toHaveLength(
            MAX_PENDING_ACCESS_REQUESTS,
        );
    });

    it('replaces an earlier request from the same person', async () => {
        const { client, controller } = engineAt();
        controller.requestAccess({ ...petr, proposedRole: 'member' });
        const second = controller.requestAccess({ ...petr, code: '111111', proposedRole: 'admin' });
        expect(ok(await client.members.listAccessRequests({}, signal())).items).toEqual([second]);
    });

    it('answers capability-not-supported on an engine without access-requests@1', async () => {
        const { client } = createInMemoryEngine({ capabilities: [KNOWN_CAPABILITIES.runs] });
        expect(code(await client.members.listAccessRequests({}, signal()))).toBe('capability-not-supported');
        expect(code(await client.settings.setDashboardRemovals({ enabled: false }, signal()))).toBe(
            'capability-not-supported',
        );
        expect(ok(await client.settings.get(signal())).dashboardRemovals).toBeNull();
    });
});

describe('access request guards', () => {
    it('declares approval and the removals switch behind step-up and their manage permissions', () => {
        expect(ENGINE_API_ROUTES.listAccessRequests).toMatchObject({ permission: 'members.read' });
        expect(ENGINE_API_ROUTES.approveAccessRequest).toMatchObject({ permission: 'members.manage', stepUp: true });
        expect(ENGINE_API_ROUTES.declineAccessRequest).toMatchObject({ permission: 'members.manage' });
        expect(ENGINE_API_ROUTES.setDashboardRemovals).toMatchObject({ permission: 'settings.manage', stepUp: true });
    });

    it('lets nobody in without a fresh step-up, even with the right code', async () => {
        const { client, controller } = engineAt(AT, { stepUp: 'required' });
        const request = controller.requestAccess({ ...petr, proposedRole: 'member' });
        const approved = await client.members.approveAccessRequest(
            request.id,
            { code: petr.code, role: 'member' },
            signal(),
        );
        expect(code(approved)).toBe('step-up-required');
        expect(code(await client.settings.setDashboardRemovals({ enabled: false }, signal()))).toBe('step-up-required');
        expect(controller.inspect().accessRequests).toEqual([request]);
        expect(controller.inspect().members.some((member) => member.dashboardUserId === petr.dashboardUserId)).toBe(
            false,
        );
        expect(ok(await client.settings.get(signal())).dashboardRemovals).toBe(true);
    });

    it('lets someone with members.read see requests but neither approve nor decline them', async () => {
        const { client, controller } = engineAt(AT, {
            member: { id: 'member-viewer', role: 'viewer', permissions: ['members.read', 'settings.read'] },
        });
        const request = controller.requestAccess({ ...petr, proposedRole: 'member' });
        expect(ok(await client.members.listAccessRequests({}, signal())).items).toEqual([request]);
        const approved = await client.members.approveAccessRequest(
            request.id,
            { code: petr.code, role: 'admin' },
            signal(),
        );
        expect(code(approved)).toBe('forbidden');
        expect(code(await client.members.declineAccessRequest(request.id, signal()))).toBe('forbidden');
        expect(code(await client.settings.setDashboardRemovals({ enabled: false }, signal()))).toBe('forbidden');
        expect(controller.inspect().accessRequests).toEqual([request]);
    });

    it('binds a code to its own request: another waiting person’s code does not approve it', async () => {
        const { client, controller } = engineAt();
        const first = controller.requestAccess({ ...petr, proposedRole: 'member' });
        controller.requestAccess({ ...petr, dashboardUserId: 'user-eva', code: '111111', proposedRole: 'member' });
        const crossed = await client.members.approveAccessRequest(
            first.id,
            { code: '111111', role: 'member' },
            signal(),
        );
        expect(code(crossed)).toBe('access-code-mismatch');
        expect(controller.inspect().accessRequests).toHaveLength(2);
    });

    it('refuses an approval after the request expired', async () => {
        const { client, controller, advance } = engineAt();
        const request = controller.requestAccess({ ...petr, proposedRole: 'member' });
        advance(7 * 24 * 60 * 60 * 1000);
        const late = await client.members.approveAccessRequest(
            request.id,
            { code: petr.code, role: 'member' },
            signal(),
        );
        expect(code(late)).toBe('not-found');
    });

    it.each([
        ['an unknown field', { code: petr.code, role: 'member', dashboardUserId: 'user-mallory' }],
        ['a code with letters', { code: '48291a', role: 'member' }],
        ['a role outside the contract', { code: petr.code, role: 'superuser' }],
    ])('rejects an approval body with %s', async (_, body) => {
        const { client, controller } = engineAt();
        const request = controller.requestAccess({ ...petr, proposedRole: 'member' });
        const response = await client.members.approveAccessRequest(request.id, body as never, signal());
        expect(code(response)).toBe('validation-failed');
        expect(controller.inspect().accessRequests).toEqual([request]);
    });
});

describe('dashboard revocations', () => {
    async function joined() {
        const engine = engineAt();
        const request = engine.controller.requestAccess({ ...petr, proposedRole: 'member' });
        const member = ok(
            await engine.client.members.approveAccessRequest(request.id, { code: petr.code, role: 'member' }, signal()),
        );
        return { ...engine, member };
    }

    it('disables the member, ends their sessions and deletes their passkeys', async () => {
        const { client, controller, member } = await joined();
        controller.addSession({
            id: 'session-petr',
            memberId: member.id,
            passkeyId: null,
            createdAt: AT,
            lastSeenAt: AT,
            expiresAt: '2026-10-31T08:00:00Z',
            client: null,
        });
        expect(controller.revokeDashboardMember('user-petr')).toBe('revoked');
        expect(ok(await client.members.get(member.id, signal())).status).toBe('disabled');
        expect(ok(await client.passkeys.list({ memberId: member.id }, signal())).items).toEqual([]);
        expect(controller.inspect().sessions.some((session) => session.memberId === member.id)).toBe(false);
        expect(controller.revokeDashboardMember('user-petr')).toBe('not-found');
    });

    it('also withdraws a pending request', async () => {
        const { client, controller } = engineAt();
        controller.requestAccess({ ...petr, proposedRole: 'member' });
        expect(controller.revokeDashboardMember('user-petr')).toBe('not-found');
        expect(ok(await client.members.listAccessRequests({}, signal())).items).toEqual([]);
    });

    it('refuses when the owner switched removals off, and never touches the last owner', async () => {
        const { client, controller } = await joined();
        expect(ok(await client.settings.get(signal())).dashboardRemovals).toBe(true);
        ok(await client.settings.setDashboardRemovals({ enabled: false }, signal()));
        expect(controller.revokeDashboardMember('user-petr')).toBe('refused-disabled');
        ok(await client.settings.setDashboardRemovals({ enabled: true }, signal()));

        const owner = ok(await client.me.get(signal())).memberId;
        controller.addMember({
            id: 'member-solo',
            displayName: 'Solo',
            role: 'owner',
            status: 'active',
            createdAt: AT,
            lastSeenAt: null,
            dashboardUserId: 'user-solo',
        });
        ok(await client.members.update(MemberId.parse(owner), { role: 'admin' }, signal()));
        expect(controller.revokeDashboardMember('user-solo')).toBe('refused-owner');
    });
});

describe('dashboard revocations and members who joined another way', () => {
    it('never reaches a member without a dashboard user ID, whatever the revocation names', async () => {
        const { client, controller } = engineAt();
        controller.addMember({
            id: 'member-invited',
            displayName: 'Invited by link',
            role: 'member',
            status: 'active',
            createdAt: AT,
            lastSeenAt: null,
        });
        for (const target of ['member-invited', 'Invited by link', 'member-owner', 'null']) {
            expect(controller.revokeDashboardMember(target)).toBe('not-found');
        }
        const members = ok(await client.members.list({ limit: 100 }, signal())).items;
        expect(members.every((member) => member.status === 'active')).toBe(true);
    });
});

describe('last owner', () => {
    it('cannot be removed or demoted', async () => {
        const { client } = engineAt();
        const owner = MemberId.parse(ok(await client.me.get(signal())).memberId);
        expect(code(await client.members.remove(owner, signal()))).toBe('last-owner');
        expect(code(await client.members.update(owner, { role: 'member' }, signal()))).toBe('last-owner');
        expect(code(await client.members.update(owner, { role: 'owner' }, signal()))).toBe('ok');
    });
});
