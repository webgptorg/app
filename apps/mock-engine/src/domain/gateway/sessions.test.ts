import { KNOWN_CAPABILITIES, OWNER_PERMISSIONS } from '@ptbk/engine-api';
import { createEngineApiClient } from '@ptbk/engine-api';
import { createInMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { createSeededRandom } from '../../testing/seeded-random';
import { ROLE_PERMISSIONS } from '../authorization/policy';
import type { Authentication } from './sessions';
import {
    SESSION_ABSOLUTE_TIMEOUT_MS,
    SESSION_IDLE_TIMEOUT_MS,
    STEP_UP_WINDOW_MS,
    createSessionStore,
} from './sessions';

const AT = '2026-10-01T00:00:00Z';
const CLIENT = { ip: '198.51.100.9', userAgent: 'test' };

const member = (
    id: string,
    role: 'owner' | 'admin' | 'member' | 'viewer',
    status: 'active' | 'invited' | 'disabled' = 'active',
) => ({
    id,
    displayName: id,
    role,
    status,
    createdAt: AT,
    lastSeenAt: null,
});

function setup() {
    const clock = createFakeClock(Date.parse(AT));
    const core = createInMemoryEngineCore({
        member: { id: 'member-owner', role: 'owner' },
        clock: { now: () => new Date(clock.nowMs()) },
        capabilities: [KNOWN_CAPABILITIES.members],
        seed: {
            members: [member('member-owner', 'owner'), member('member-ada', 'member')],
            passkeys: [
                { id: 'passkey-ada-old', memberId: 'member-ada', name: 'Old', createdAt: AT, lastUsedAt: null },
                {
                    id: 'passkey-ada-new',
                    memberId: 'member-ada',
                    name: 'New',
                    createdAt: '2026-10-01T00:00:01Z',
                    lastUsedAt: null,
                },
                { id: 'passkey-owner', memberId: 'member-owner', name: 'Owner', createdAt: AT, lastUsedAt: null },
            ],
            sessions: [
                {
                    id: 'session-seeded',
                    memberId: 'member-ada',
                    current: false,
                    client: null,
                    createdAt: AT,
                    lastSeenAt: AT,
                    expiresAt: '2026-10-02T00:00:00Z',
                },
            ],
        },
    });
    const store = createSessionStore({ engine: () => core.controller, clock, random: createSeededRandom(7) });
    const listed = (): string[] => core.controller.inspect().sessions.map(({ id }) => id);
    return { clock, core, store, listed };
}

function signedIn(result: Authentication) {
    if (result.kind !== 'signed-in') throw new Error('expected a signed-in session');
    return result.actor;
}

describe('gateway session store', () => {
    it('creates an engine session per sign-in, with a token that is not the session ID', () => {
        const { store, listed } = setup();
        const first = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        const second = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        expect(first.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(first.sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(first.token).not.toBe(first.sessionId);
        expect(second.token).not.toBe(first.token);
        expect(second.sessionId).not.toBe(first.sessionId);
        expect(listed().sort()).toEqual([first.sessionId, second.sessionId, 'session-seeded'].sort());
        expect(first.memberId).toBe('member-ada');
    });

    it('records the sign-in client and an expiry at the absolute timeout', () => {
        const { store, core, clock } = setup();
        const { sessionId } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        const session = core.controller.inspect().sessions.find(({ id }) => id === sessionId);
        expect(session).toMatchObject({
            memberId: 'member-ada',
            client: CLIENT,
            createdAt: AT,
            expiresAt: new Date(clock.nowMs() + SESSION_ABSOLUTE_TIMEOUT_MS).toISOString().replace('.000Z', 'Z'),
        });
    });

    it("signs in with the member's newest passkey, and revoking it signs the session out", async () => {
        const { store, core } = setup();
        const { token, sessionId } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        const session = core.controller.inspect().sessions.find(({ id }) => id === sessionId);
        expect(session?.passkeyId).toBe('passkey-ada-new');
        const ada = createEngineApiClient(
            core.transport({ ...signedIn(store.authenticate(token, CLIENT)), stepUpFresh: true }),
        );
        const revoked = await ada.me.revokePasskey('passkey-ada-new' as never, AbortSignal.timeout(5_000));
        expect(revoked.kind).toBe('ok');
        expect(store.authenticate(token, CLIENT).kind).toBe('invalid');
    });

    it('resolves a token to the actor with the role permissions of the member', () => {
        const { store } = setup();
        const { token, sessionId } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        const actor = signedIn(store.authenticate(token, { ip: '203.0.113.1', userAgent: 'other' }));
        expect(actor).toMatchObject({ memberId: 'member-ada', sessionId, client: { ip: '203.0.113.1' } });
        expect([...actor.permissions].sort()).toEqual([...ROLE_PERMISSIONS.member].sort());
        expect(store.authenticate('nope', CLIENT)).toEqual({ kind: 'invalid' });
    });

    it('prefers an explicit permission set over the role, deduplicated', () => {
        const { store } = setup();
        const { token } = store.signIn({
            memberId: 'member-owner',
            permissions: ['agents.read', 'agents.read', 'wallet.read'],
            client: CLIENT,
        });
        expect([...signedIn(store.authenticate(token, CLIENT)).permissions]).toEqual(['agents.read', 'wallet.read']);
    });

    it('applies a role change on the next request', async () => {
        const { store, core } = setup();
        const { token } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        const owner = createEngineApiClient(
            core.transport({
                memberId: 'member-owner' as never,
                sessionId: 'session-x' as never,
                client: CLIENT,
                permissions: new Set(OWNER_PERMISSIONS),
                stepUpFresh: true,
            }),
        );
        const updated = await owner.members.update(
            'member-ada' as never,
            { role: 'viewer' },
            AbortSignal.timeout(5000),
        );
        expect(updated.kind).toBe('ok');
        expect([...signedIn(store.authenticate(token, CLIENT)).permissions].sort()).toEqual(
            [...ROLE_PERMISSIONS.viewer].sort(),
        );
    });

    it('expires an idle session and removes it from the engine', () => {
        const { store, clock, listed } = setup();
        const { token, sessionId } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        clock.advance(SESSION_IDLE_TIMEOUT_MS);
        signedIn(store.authenticate(token, CLIENT));
        clock.advance(SESSION_IDLE_TIMEOUT_MS + 1);
        expect(store.authenticate(token, CLIENT)).toEqual({ kind: 'invalid' });
        expect(listed()).not.toContain(sessionId);
        expect(store.authenticate(token, CLIENT)).toEqual({ kind: 'invalid' });
    });

    it('ends a session at the absolute timeout however active it is', () => {
        const { store, clock, listed } = setup();
        const { token, sessionId } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        for (let elapsed = 0; elapsed < SESSION_ABSOLUTE_TIMEOUT_MS; elapsed += SESSION_IDLE_TIMEOUT_MS / 2) {
            clock.advance(SESSION_IDLE_TIMEOUT_MS / 2);
            if (elapsed + SESSION_IDLE_TIMEOUT_MS / 2 <= SESSION_ABSOLUTE_TIMEOUT_MS) {
                signedIn(store.authenticate(token, CLIENT));
            }
        }
        clock.advance(1);
        expect(store.authenticate(token, CLIENT)).toEqual({ kind: 'invalid' });
        expect(listed()).not.toContain(sessionId);
    });

    it('refuses a session the engine no longer lists', () => {
        const { store, core } = setup();
        const { token, sessionId } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        core.controller.removeSession(sessionId);
        expect(store.authenticate(token, CLIENT)).toEqual({ kind: 'invalid' });
    });

    it('refuses a removed or disabled member', async () => {
        const { store, core, listed } = setup();
        const ada = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        const owner = createEngineApiClient(
            core.transport({
                memberId: 'member-owner' as never,
                sessionId: 'session-x' as never,
                client: CLIENT,
                permissions: new Set(OWNER_PERMISSIONS),
                stepUpFresh: true,
            }),
        );
        expect((await owner.members.remove('member-ada' as never, AbortSignal.timeout(5000))).kind).toBe('ok');
        expect(store.authenticate(ada.token, CLIENT)).toEqual({ kind: 'invalid' });
        expect(listed()).not.toContain(ada.sessionId);

        core.controller.addMember(member('member-gone', 'member', 'disabled'));
        expect(() => store.signIn({ memberId: 'member-gone', permissions: null, client: CLIENT })).toThrow();
        expect(() => store.signIn({ memberId: 'member-nobody', permissions: null, client: CLIENT })).toThrow();
    });

    it('treats a sign-in as a fresh assertion for the step-up window, and the step-up form renews it', () => {
        const { store, clock } = setup();
        const { token, sessionId } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        expect(signedIn(store.authenticate(token, CLIENT)).stepUpFresh).toBe(true);
        clock.advance(STEP_UP_WINDOW_MS);
        expect(signedIn(store.authenticate(token, CLIENT)).stepUpFresh).toBe(true);
        clock.advance(1);
        expect(signedIn(store.authenticate(token, CLIENT)).stepUpFresh).toBe(false);
        expect(store.confirmStepUp(sessionId)).toBe(true);
        expect(signedIn(store.authenticate(token, CLIENT)).stepUpFresh).toBe(true);
        expect(store.confirmStepUp('session-unknown')).toBe(false);
    });

    it('lets every assertion go stale on demand, until the next step-up', () => {
        const { store } = setup();
        const ada = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        const again = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        store.expireStepUps();
        expect(signedIn(store.authenticate(ada.token, CLIENT)).stepUpFresh).toBe(false);
        expect(signedIn(store.authenticate(again.token, CLIENT)).stepUpFresh).toBe(false);
        expect(store.confirmStepUp(ada.sessionId)).toBe(true);
        expect(signedIn(store.authenticate(ada.token, CLIENT)).stepUpFresh).toBe(true);
    });

    it('signs in without a fresh assertion when told so', () => {
        const { store } = setup();
        const { token } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT, stepUp: 'none' });
        expect(signedIn(store.authenticate(token, CLIENT)).stepUpFresh).toBe(false);
    });

    it("resumes a session the engine already lists for the member, but never another member's", () => {
        const { store, listed } = setup();
        const resumed = store.signIn({
            memberId: 'member-ada',
            permissions: null,
            client: CLIENT,
            sessionId: 'session-seeded',
        });
        expect(resumed.sessionId).toBe('session-seeded');
        expect(listed()).toEqual(['session-seeded']);
        const other = store.signIn({
            memberId: 'member-owner',
            permissions: null,
            client: CLIENT,
            sessionId: 'session-seeded',
        });
        expect(other.sessionId).not.toBe('session-seeded');
        expect(listed()).toHaveLength(2);
    });

    it('signs out every token of a session and removes it from the engine', () => {
        const { store, listed } = setup();
        const first = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        const second = store.signIn({
            memberId: 'member-ada',
            permissions: null,
            client: CLIENT,
            sessionId: first.sessionId,
        });
        store.signOut(first.sessionId);
        expect(store.authenticate(first.token, CLIENT)).toEqual({ kind: 'invalid' });
        expect(store.authenticate(second.token, CLIENT)).toEqual({ kind: 'invalid' });
        expect(listed()).toEqual(['session-seeded']);
        store.signOut('session-seeded');
        expect(listed()).toEqual([]);
    });

    it('forgets every token on clear', () => {
        const { store } = setup();
        const { token } = store.signIn({ memberId: 'member-ada', permissions: null, client: CLIENT });
        store.clear();
        expect(store.authenticate(token, CLIENT)).toEqual({ kind: 'invalid' });
    });
});
