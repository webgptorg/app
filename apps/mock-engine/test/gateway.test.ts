import type { Member } from '@ptbk/engine-api';
import { ENGINE_UI_CSP, SIGN_IN_PATH, STEP_UP_PATH } from '@ptbk/engine-api';
import { afterEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE_NAME, SESSION_IDLE_TIMEOUT_MS, STEP_UP_WINDOW_MS } from '../src/domain/gateway/sessions';
import type { ApiHarness, ApiHarnessOptions } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';
import type { FakeClock } from '../src/testing/fake-clock';
import { createFakeClock } from '../src/testing/fake-clock';

let harness: ApiHarness | undefined;
afterEach(async () => {
    await harness?.close();
    harness = undefined;
});

async function start(options: ApiHarnessOptions = {}): Promise<{ harness: ApiHarness; clock: FakeClock }> {
    const clock = createFakeClock(Date.now());
    harness = await createApiHarness({ clock, devLogin: true, ...options });
    return { harness, clock };
}

function memberWith(engine: ApiHarness, role: Member['role']): Member {
    const member = engine
        .core()
        .controller.inspect()
        .members.find((candidate) => candidate.role === role);
    if (member === undefined) throw new Error(`no ${role}`);
    return member;
}

function expectBaseline(response: Response): void {
    expect(response.headers.get('content-security-policy')).toBe(ENGINE_UI_CSP);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
}

async function problemOf(response: Response): Promise<{ status: number; code: string }> {
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    return (await response.json()) as { status: number; code: string };
}

const api = (path: string) => `${HARNESS_ORIGIN}/api/v1${path}`;

describe('cross-site requests', () => {
    it.each([
        ['a cross-site Fetch Metadata', { origin: HARNESS_ORIGIN, 'sec-fetch-site': 'cross-site' }],
        ['a same-site Fetch Metadata', { origin: HARNESS_ORIGIN, 'sec-fetch-site': 'same-site' }],
        ['a foreign Origin', { origin: 'https://attacker.example', 'sec-fetch-site': 'same-origin' }],
        ['no Origin', { 'sec-fetch-site': 'same-origin' }],
        ['no Fetch Metadata', { origin: HARNESS_ORIGIN }],
    ])('refuses a POST with %s with 403 before anything else runs', async (_name, headers) => {
        const { harness: engine } = await start();
        const cookie = engine.signIn({ memberId: engine.ownerId() });
        const fetch = engine.rawFetch();
        for (const path of ['/api/v1/folders', '/nowhere', SIGN_IN_PATH]) {
            const response = await fetch(`${HARNESS_ORIGIN}${path}`, {
                method: 'POST',
                headers: { ...headers, cookie, 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Forged' }),
            });
            expect(response.status, path).toBe(403);
            expect(await problemOf(response)).toMatchObject({ code: 'forbidden' });
            expectBaseline(response);
        }
        expect(engine.core().controller.inspect().counts.folders).toBe(2);
    });

    it('accepts a same-origin POST and a Sec-Fetch-Site of none, and never checks GET', async () => {
        const { harness: engine } = await start();
        const cookie = engine.signIn({ memberId: engine.ownerId() });
        const fetch = engine.rawFetch();
        for (const site of ['same-origin', 'none']) {
            const response = await fetch(api('/folders'), {
                method: 'POST',
                headers: { origin: HARNESS_ORIGIN, 'sec-fetch-site': site, cookie, 'content-type': 'application/json' },
                body: JSON.stringify({ name: `Team ${site}` }),
            });
            expect(response.status).toBe(201);
        }
        expect((await fetch(api('/me'), { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
    });
});

describe('anonymous requests', () => {
    it('get 401 problem+json on the API and nothing else', async () => {
        const { harness: engine } = await start();
        const response = await engine.fetch(null)(api('/agents'));
        expect(response.status).toBe(401);
        expect(await problemOf(response)).toMatchObject({ code: 'unauthenticated' });
        expect(response.headers.get('set-cookie')).toBeNull();
        expectBaseline(response);
    });

    it('are sent to the sign-in page for documents', async () => {
        const { harness: engine } = await start();
        const response = await engine.fetch(null)(`${HARNESS_ORIGIN}${STEP_UP_PATH}`, { redirect: 'manual' });
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(SIGN_IN_PATH);
        expectBaseline(response);
    });

    it('keep the path and query they asked for as next, unless it is not a safe path, without logging it', async () => {
        const { harness: engine } = await start();
        const locationOf = async (path: string) => {
            const response = await engine.fetch(null)(`${HARNESS_ORIGIN}${path}`, { redirect: 'manual' });
            expect(response.status, path).toBe(303);
            return response.headers.get('location');
        };
        expect(await locationOf('/agents/agent-deep-link?tab=chat#reply')).toBe(
            `${SIGN_IN_PATH}?next=%2Fagents%2Fagent-deep-link%3Ftab%3Dchat`,
        );
        expect(await locationOf('/')).toBe(SIGN_IN_PATH);
        expect(await locationOf('//evil.example/agent-deep-link')).toBe(SIGN_IN_PATH);
        expect(await locationOf('/x/%2e%2e/setup')).toBe(SIGN_IN_PATH);
        const apiCall = await engine.fetch(null)(api('/agents?tab=chat'), { redirect: 'manual' });
        expect(apiCall.status).toBe(401);
        expect(apiCall.headers.get('location')).toBeNull();
        expect(engine.logger.text()).not.toContain('agent-deep-link');
    });

    it('have an unknown or malformed cookie cleared', async () => {
        const { harness: engine } = await start();
        for (const cookie of [`${SESSION_COOKIE_NAME}=${'a'.repeat(22)}`, `${SESSION_COOKIE_NAME}=short`]) {
            const response = await engine.fetch(cookie)(api('/me'));
            expect(response.status).toBe(401);
            expect(response.headers.get('set-cookie')).toBe(
                `${SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
            );
        }
    });
});

describe('sessions', () => {
    it('expire after the idle timeout', async () => {
        const { harness: engine, clock } = await start();
        const cookie = engine.signIn({ memberId: engine.ownerId() });
        const fetch = engine.fetch(cookie);
        expect((await fetch(api('/me'))).status).toBe(200);
        clock.advance(SESSION_IDLE_TIMEOUT_MS - 1);
        expect((await fetch(api('/me'))).status).toBe(200);
        clock.advance(SESSION_IDLE_TIMEOUT_MS + 1);
        const expired = await fetch(api('/me'));
        expect(expired.status).toBe(401);
        expect(expired.headers.get('set-cookie')).toContain('Max-Age=0');
        expect(engine.core().controller.inspect().counts.sessions).toBe(3);
    });

    it('end when the session is revoked through the API', async () => {
        const { harness: engine } = await start();
        const owner = engine.fetch(engine.signIn({ memberId: engine.ownerId() }));
        const member = memberWith(engine, 'member');
        const memberCookie = engine.signIn({ memberId: member.id });
        const me = (await (await engine.fetch(memberCookie)(api('/me/sessions'))).json()) as {
            items: { id: string; current: boolean }[];
        };
        const current = me.items.find(({ current: isCurrent }) => isCurrent);
        if (current === undefined) throw new Error('no current session');
        expect((await owner(api(`/sessions/${current.id}`), { method: 'DELETE' })).status).toBe(204);
        expect((await engine.fetch(memberCookie)(api('/me'))).status).toBe(401);
        expect(engine.recorder.violations).toEqual([]);
    });

    it('end when the member is removed, and a role change applies on the next request', async () => {
        const { harness: engine } = await start();
        const owner = engine.fetch(engine.signIn({ memberId: engine.ownerId() }));
        const [first, second] = engine
            .core()
            .controller.inspect()
            .members.filter(({ role }) => role === 'member');
        if (first === undefined || second === undefined) throw new Error('two members expected');
        const firstFetch = engine.fetch(engine.signIn({ memberId: first.id }));
        const secondFetch = engine.fetch(engine.signIn({ memberId: second.id }));
        const changed = await owner(api(`/members/${second.id}`), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role: 'viewer' }),
        });
        expect(changed.status).toBe(200);
        expect(await (await secondFetch(api('/me'))).json()).toMatchObject({ role: 'viewer' });
        expect((await owner(api(`/members/${first.id}`), { method: 'DELETE' })).status).toBe(204);
        expect((await firstFetch(api('/me'))).status).toBe(401);
        expect(engine.recorder.violations).toEqual([]);
    });

    it('name the session member and the tunnel client IP in audit entries', async () => {
        const { harness: engine } = await start();
        const admin = memberWith(engine, 'admin');
        const fetch = engine.fetch(engine.signIn({ memberId: admin.id }), '203.0.113.9');
        const me = (await (await fetch(api('/me'))).json()) as { memberId: string };
        expect(me.memberId).toBe(admin.id);
        await fetch(api('/folders'), {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'user-agent': 'gateway test' },
            body: JSON.stringify({ name: 'Audited' }),
        });
        const audit = (await (await fetch(api('/audit?action=folder.create'))).json()) as {
            items: { actor: unknown; client: unknown; outcome: string }[];
        };
        expect(audit.items[0]).toMatchObject({
            actor: { kind: 'member', memberId: me.memberId },
            client: { ip: '203.0.113.9', userAgent: 'gateway test' },
            outcome: 'success',
        });
    });

    it('sign out: the cookie is cleared and the engine no longer lists the session', async () => {
        const { harness: engine } = await start();
        const cookie = engine.signIn({ memberId: engine.ownerId() });
        const before = engine.core().controller.inspect().counts.sessions;
        const response = await engine.fetch(cookie)(`${HARNESS_ORIGIN}/auth/sign-out`, {
            method: 'POST',
            redirect: 'manual',
        });
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(SIGN_IN_PATH);
        expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
        expect(engine.core().controller.inspect().counts.sessions).toBe(before - 1);
        expect((await engine.fetch(cookie)(api('/me'))).status).toBe(401);
    });

    it('need a fresh step-up for step-up routes, which the dev form gives', async () => {
        const { harness: engine, clock } = await start();
        const fetch = engine.fetch(engine.signIn({ memberId: engine.ownerId() }));
        const setPolicy = () =>
            fetch(api('/settings/update-policy'), {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ policy: 'manual' }),
            });
        expect((await setPolicy()).status).toBe(200);
        clock.advance(STEP_UP_WINDOW_MS + 1);
        const stale = await setPolicy();
        expect(stale.status).toBe(401);
        expect(await problemOf(stale)).toMatchObject({ code: 'step-up-required' });
        const page = await fetch(`${HARNESS_ORIGIN}${STEP_UP_PATH}`);
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toContain(`action="${STEP_UP_PATH}"`);
        expect(html).not.toContain('<script');
        const confirmed = await fetch(`${HARNESS_ORIGIN}${STEP_UP_PATH}`, { method: 'POST', redirect: 'manual' });
        expect(confirmed.status).toBe(303);
        expect((await setPolicy()).status).toBe(200);
        expect(engine.recorder.violations).toEqual([]);
    });
});

describe('dev login', () => {
    it('lists the members and signs one in with a __Host- cookie', async () => {
        const { harness: engine } = await start();
        engine.core().controller.addMember({
            id: 'member-quote',
            displayName: `O'Brien <b>`,
            role: 'viewer',
            status: 'active',
            createdAt: '2026-10-01T00:00:00Z',
            lastSeenAt: null,
        });
        const page = await engine.fetch(null)(`${HARNESS_ORIGIN}${SIGN_IN_PATH}`);
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expectBaseline(page);
        const html = await page.text();
        for (const { displayName } of engine
            .core()
            .controller.inspect()
            .members.filter(({ id }) => id !== 'member-quote')) {
            expect(html).toContain(displayName.replaceAll("'", '&#39;'));
        }
        expect(html).toContain('O&#39;Brien &#60;b&#62;');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('style=');

        const owner = memberWith(engine, 'owner');
        const signedIn = await engine.fetch(null)(`${HARNESS_ORIGIN}${SIGN_IN_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `memberId=${owner.id}`,
            redirect: 'manual',
        });
        expect(signedIn.status).toBe(303);
        expect(signedIn.headers.get('location')).toBe('/');
        const setCookie = signedIn.headers.get('set-cookie') ?? '';
        expect(setCookie).toMatch(
            new RegExp(
                `^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{22}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=\\d+$`,
            ),
        );
        const cookie = setCookie.split(';')[0] ?? '';
        expect(await (await engine.fetch(cookie)(api('/me'))).json()).toMatchObject({ memberId: owner.id });
    });

    it('signs in to the page the member asked for, and only to a safe one', async () => {
        const { harness: engine } = await start();
        const anonymous = engine.fetch(null);
        const next = '/agents/a?tab=chat&q=%22';
        const page = await anonymous(`${HARNESS_ORIGIN}${SIGN_IN_PATH}?${new URLSearchParams({ next }).toString()}`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('<input type="hidden" name="next" value="/agents/a?tab=chat&#38;q=%22">');
        const hostile = await anonymous(`${HARNESS_ORIGIN}${SIGN_IN_PATH}?next=%2F%2Fevil.example`);
        expect(await hostile.text()).not.toContain('name="next"');
        const signIn = (body: Record<string, string>) =>
            anonymous(`${HARNESS_ORIGIN}${SIGN_IN_PATH}`, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ memberId: engine.ownerId(), ...body }).toString(),
                redirect: 'manual',
            });
        expect((await signIn({ next })).headers.get('location')).toBe(next);
        for (const unsafe of ['//evil.example', 'https://evil.example/', '/auth/sign-in', '/setup']) {
            expect((await signIn({ next: unsafe })).headers.get('location'), unsafe).toBe('/');
        }
        for (const unencoded of ['/Ā', '/　/evil.example']) {
            const response = await signIn({ next: unencoded });
            expect([response.status, response.headers.get('location')], unencoded).toEqual([303, '/']);
        }
    });

    it('refuses an unknown member', async () => {
        const { harness: engine } = await start();
        const response = await engine.fetch(null)(`${HARNESS_ORIGIN}${SIGN_IN_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'memberId=member-nobody',
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ errors: [{ path: 'body.memberId' }] });
    });

    it('does not exist when disabled', async () => {
        const { harness: engine } = await start({ devLogin: false });
        const page = await engine.fetch(null)(`${HARNESS_ORIGIN}${SIGN_IN_PATH}`);
        expect(await page.text()).toContain('disabled');
        const response = await engine.fetch(null)(`${HARNESS_ORIGIN}${SIGN_IN_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: `memberId=${engine.ownerId()}`,
        });
        expect(response.status).toBe(404);
        const stepUp = await engine.fetch(engine.signIn({ memberId: engine.ownerId() }))(
            `${HARNESS_ORIGIN}${STEP_UP_PATH}`,
        );
        expect(stepUp.status).toBe(404);
    });
});
