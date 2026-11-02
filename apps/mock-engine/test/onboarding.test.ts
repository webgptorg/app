import { readFile } from 'node:fs/promises';

import { ENGINE_UI_CSP, SIGN_IN_PATH, STEP_UP_PATH } from '@ptbk/engine-api';
import { GATEWAY_PAGES_DIR } from '@ptbk/gateway-pages';
import { deriveEngineFingerprint } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { RelyingParty } from '../src/domain/gateway/passkey-ceremonies';
import { SESSION_COOKIE_NAME } from '../src/domain/gateway/sessions';
import { SETUP_SECRET_LIFETIME_MS } from '../src/domain/onboarding/setup-secret';
import type { ApiHarness } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';
import { HARNESS_CLIENT_IP, HARNESS_ENGINE_ID, HARNESS_HOSTNAME } from '../src/testing/engine-harness';
import type { FakeClock } from '../src/testing/fake-clock';
import { createFakeClock } from '../src/testing/fake-clock';

const RP: RelyingParty = { id: HARNESS_HOSTNAME, origin: `https://${HARNESS_HOSTNAME}` };

let harness: ApiHarness | undefined;
afterEach(async () => {
    await harness?.close();
    harness = undefined;
});

async function start(): Promise<{ engine: ApiHarness; clock: FakeClock }> {
    // From the real now: the dev CA dates its certificates by this clock, the TLS client checks them by the real one.
    const clock = createFakeClock(Date.now());
    harness = await createApiHarness({ clock, onboarding: {} });
    return { engine: harness, clock };
}

function onboardingOf(engine: ApiHarness) {
    if (engine.onboarding === null) throw new Error('no onboarding');
    return engine.onboarding;
}

async function post(engine: ApiHarness, path: string, body: unknown, cookie: string | null = null) {
    return engine.fetch(cookie)(`${HARNESS_ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function cookieOf(response: Response): string {
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toMatch(
        new RegExp(`^${SESSION_COOKIE_NAME}=[A-Za-z0-9_-]{22}; Secure; HttpOnly; SameSite=Strict; Path=/`),
    );
    return header.split(';')[0] ?? '';
}

/** What the setup page does: options with the secret, a passkey, verify with the secret. */
async function setUpOwner(engine: ApiHarness, secret: string, credentialId = 'credential-owner'): Promise<Response> {
    const options = await post(engine, '/setup/options', { secret });
    expect(options.status).toBe(200);
    const { options: creation } = (await options.json()) as { options: unknown };
    const response = onboardingOf(engine).ceremonies.register(creation, credentialId, RP);
    return post(engine, '/setup/verify', { secret, response });
}

async function codeOf(response: Response): Promise<string> {
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    return ((await response.json()) as { code: string }).code;
}

describe('the setup page', () => {
    it('is served to anyone under the engine CSP, with the identity to compare and no secret', async () => {
        const { engine } = await start();
        const response = await engine.fetch(null)(`${HARNESS_ORIGIN}/setup`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(response.headers.get('content-security-policy')).toBe(ENGINE_UI_CSP);
        const html = await response.text();
        expect(html).toContain('<html lang="en">');
        expect(html).toContain('data-page="setup" data-owner="none"');
        expect(html).toContain(`<dd>${HARNESS_ENGINE_ID}</dd>`);
        expect(html).toContain(`https://${HARNESS_HOSTNAME}`);
        expect(html).toContain(deriveEngineFingerprint(HARNESS_ENGINE_ID).formatted);
        expect(html).not.toMatch(/<script>|<style|style="|\bon[a-z]+="/);
        const czech = await engine.fetch(null)(`${HARNESS_ORIGIN}/setup`, {
            headers: { 'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.5' },
        });
        expect(await czech.text()).toContain('<html lang="cs">');
    });

    it('serves its assets byte for byte with their types', async () => {
        const { engine } = await start();
        for (const [name, type] of [
            ['gateway.js', 'text/javascript; charset=utf-8'],
            ['gateway.css', 'text/css; charset=utf-8'],
            ['simplewebauthn-browser.umd.min.js', 'text/javascript; charset=utf-8'],
        ] as const) {
            const response = await engine.fetch(null)(`${HARNESS_ORIGIN}/auth/assets/${name}`);
            expect(response.status, name).toBe(200);
            expect(response.headers.get('content-type')).toBe(type);
            expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(new URL(name, GATEWAY_PAGES_DIR)));
        }
        expect((await engine.fetch(null)(`${HARNESS_ORIGIN}/auth/assets/other.js`)).status).toBe(400);
    });

    it('refuses a secret sent in a query string instead of the fragment, and never logs it', async () => {
        const { engine } = await start();
        const secret = await onboardingOf(engine).issue();
        for (const query of [`?secret=${secret}`, `?${secret}`]) {
            const response = await engine.fetch(null)(`${HARNESS_ORIGIN}/setup${query}`);
            expect(response.status).toBe(400);
            expect(await response.text()).not.toContain(secret);
        }
        expect(engine.logger.text()).not.toContain(secret);
        expect(await onboardingOf(engine).secrets.check(secret)).toBe('valid');
    });
});

describe('setting up the owner', () => {
    it('registers the owner passkey, signs them in, audits it with the client IP and closes setup for good', async () => {
        const { engine } = await start();
        const secret = await onboardingOf(engine).issue();
        const verified = await setUpOwner(engine, secret);
        expect(verified.status).toBe(200);
        expect(await verified.json()).toEqual({ next: '/' });
        const cookie = cookieOf(verified);
        const me = await engine.fetch(cookie)(`${HARNESS_ORIGIN}/api/v1/me`);
        expect(me.status).toBe(200);
        expect(((await me.json()) as { role: string }).role).toBe('owner');
        const audit = engine.core().controller.inspect();
        expect(audit.passkeys.filter(({ name }) => name === 'Built-in passkey')).toHaveLength(1);
        const entries = await engine
            .client(cookie)
            .audit.list({ action: 'passkey.register' }, AbortSignal.timeout(5_000));
        if (entries.kind !== 'ok') throw new Error('audit');
        expect(entries.data.items.map(({ client, outcome }) => ({ ip: client?.ip, outcome }))).toEqual([
            { ip: HARNESS_CLIENT_IP, outcome: 'success' },
        ]);

        expect(await codeOf(await post(engine, '/setup/options', { secret }))).toBe('owner-exists');
        expect(await codeOf(await setUpOwnerAgain(engine, secret))).toBe('owner-exists');
        const page = await (await engine.fetch(null)(`${HARNESS_ORIGIN}/setup`)).text();
        expect(page).toContain('data-owner="set"');
        expect(engine.logger.text()).not.toContain(secret);
    });

    it('answers a wrong, a malformed, a replaced and an expired secret the same way', async () => {
        const { engine, clock } = await start();
        const first = await onboardingOf(engine).issue();
        const second = await onboardingOf(engine).issue();
        const answers = [];
        for (const secret of [first, 'A'.repeat(22), 'not-a-secret', '']) {
            const response = await post(engine, '/setup/options', { secret });
            answers.push([response.status, await response.text()]);
        }
        clock.advance(SETUP_SECRET_LIFETIME_MS);
        const expired = await post(engine, '/setup/options', { secret: second });
        answers.push([expired.status, await expired.text()]);
        expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(
            new Set([
                JSON.stringify([
                    403,
                    JSON.stringify({
                        type: 'about:blank',
                        title: 'setup-link-invalid',
                        status: 403,
                        code: 'setup-link-invalid',
                    }),
                ]),
            ]),
        );
    });

    it('refuses a setup from another origin before anything reads the secret', async () => {
        const { engine } = await start();
        const secret = await onboardingOf(engine).issue();
        const response = await engine.rawFetch()(`${HARNESS_ORIGIN}/setup/options`, {
            method: 'POST',
            headers: {
                origin: 'https://attacker.example',
                'sec-fetch-site': 'cross-site',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ secret }),
        });
        expect(response.status).toBe(403);
        expect(await onboardingOf(engine).secrets.check(secret)).toBe('valid');
    });

    it('keeps the secret when the passkey does not verify', async () => {
        const { engine } = await start();
        const secret = await onboardingOf(engine).issue();
        const response = await post(engine, '/setup/verify', { secret, response: { not: 'a credential' } });
        expect(response.status).toBe(400);
        expect(await codeOf(response)).toBe('passkey-not-verified');
        expect((await setUpOwner(engine, secret)).status).toBe(200);
    });

    it('rate-limits the setup endpoints per client IP', async () => {
        const { engine } = await start();
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 11; attempt++) {
            statuses.push((await post(engine, '/setup/options', { secret: 'A'.repeat(22) })).status);
        }
        expect(statuses.slice(0, 10)).toEqual(new Array<number>(10).fill(403));
        expect(statuses[10]).toBe(429);
        const fromElsewhere = await engine.fetch(null, '203.0.113.50')(`${HARNESS_ORIGIN}/setup/options`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ secret: 'A'.repeat(22) }),
        });
        expect(fromElsewhere.status).toBe(403);
    });
});

async function setUpOwnerAgain(engine: ApiHarness, secret: string): Promise<Response> {
    const response = onboardingOf(engine).ceremonies.register({ challenge: 'stale' }, 'credential-second', RP);
    return post(engine, '/setup/verify', { secret, response });
}

describe('signing in and stepping up with the passkey', () => {
    async function owned() {
        const { engine, clock } = await start();
        const verified = await setUpOwner(engine, await onboardingOf(engine).issue());
        return { engine, clock, ownerCookie: cookieOf(verified) };
    }

    async function signIn(engine: ApiHarness, credentialId: string, next?: string): Promise<Response> {
        const options = await post(engine, `${SIGN_IN_PATH}/options`, {});
        const { options: request } = (await options.json()) as { options: unknown };
        const response = onboardingOf(engine).ceremonies.assert(request, credentialId, RP);
        return post(engine, `${SIGN_IN_PATH}/verify`, next === undefined ? { response } : { response, next });
    }

    it('serves the sign-in page with the next path, and signs in with a safe next only', async () => {
        const { engine } = await owned();
        const page = await engine.fetch(null)(`${HARNESS_ORIGIN}${SIGN_IN_PATH}?next=%2Fagents`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('data-page="sign-in" data-owner="set"');
        const toAgents = await signIn(engine, 'credential-owner', '/agents');
        expect(await toAgents.json()).toEqual({ next: '/agents' });
        expect((await engine.fetch(cookieOf(toAgents))(`${HARNESS_ORIGIN}/api/v1/me`)).status).toBe(200);
        for (const next of ['//evil.example', 'https://evil.example', '/auth/sign-in']) {
            expect(await (await signIn(engine, 'credential-owner', next)).json()).toEqual({ next: '/' });
        }
        const unknown = await signIn(engine, 'credential-unknown');
        expect(unknown.status).toBe(401);
        expect(await codeOf(unknown)).toBe('passkey-not-recognised');
    });

    it('serves a sign-in page that first asks /me, which answers the session a cross-site link left behind', async () => {
        const { engine, ownerCookie } = await owned();
        const page = await (
            await engine.fetch(null)(`${HARNESS_ORIGIN}${SIGN_IN_PATH}?next=%2F%2Fevil.example`)
        ).text();
        expect(page).toContain('<section data-state="checking" hidden>');
        expect(page).not.toContain('evil.example');
        const script = await (await engine.fetch(null)(`${HARNESS_ORIGIN}/auth/assets/gateway.js`)).text();
        expect(script).toContain("const ME_PATH = '/api/v1/me';");
        // The cookie the browser held back on the cross-site navigation goes with the page's own same-origin request.
        const me = (cookie: string | null) =>
            engine.fetch(cookie)(`${HARNESS_ORIGIN}/api/v1/me`, { headers: { 'sec-fetch-site': 'same-origin' } });
        expect((await me(ownerCookie)).status).toBe(200);
        const anonymous = await me(null);
        expect(anonymous.status).toBe(401);
        expect(await codeOf(anonymous)).toBe('unauthenticated');
    });

    it('confirms a step-up with a fresh assertion for the session', async () => {
        const { engine, clock, ownerCookie } = await owned();
        clock.advance(10 * 60_000);
        const anonymous = await post(engine, `${STEP_UP_PATH}/options`, {});
        expect(anonymous.status).toBe(401);
        const page = await engine.fetch(ownerCookie)(`${HARNESS_ORIGIN}${STEP_UP_PATH}?returnTo=%2Fsettings`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('data-page="step-up"');
        const policy = () =>
            engine.fetch(ownerCookie)(`${HARNESS_ORIGIN}/api/v1/settings/update-policy`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ policy: 'manual' }),
            });
        expect(await codeOf(await policy())).toBe('step-up-required');
        const options = await post(engine, `${STEP_UP_PATH}/options`, {}, ownerCookie);
        const { options: request } = (await options.json()) as { options: unknown };
        const response = onboardingOf(engine).ceremonies.assert(request, 'credential-owner', RP);
        const confirmed = await post(engine, `${STEP_UP_PATH}/verify`, { response, next: '/settings' }, ownerCookie);
        expect(await confirmed.json()).toEqual({ next: '/settings' });
        expect((await policy()).status).toBe(200);
    });

    it('ends every session and passkey on owner reset, and setup works again', async () => {
        const { engine, ownerCookie } = await owned();
        expect(await onboardingOf(engine).gateway.resetOwner()).toMatchObject({ passkeys: 1 });
        expect((await engine.fetch(ownerCookie)(`${HARNESS_ORIGIN}/api/v1/me`)).status).toBe(401);
        expect((await signIn(engine, 'credential-owner')).status).toBe(401);
        expect((await setUpOwner(engine, await onboardingOf(engine).issue(), 'credential-new')).status).toBe(200);
    });
});
