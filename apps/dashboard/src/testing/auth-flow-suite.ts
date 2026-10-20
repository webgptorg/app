import { beforeEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../domain/auth/secrets';
import { RECOVERY_COOLDOWN_MS, type Actor } from '../domain/authz/authorizer';
import type { DashboardAction } from '../domain/authz/policy';
import type { SessionView } from '../shared/api/routes';
import type { AuthHarness, TestBrowser } from './auth-harness';
import { ORIGIN } from './auth-harness';
import {
    lastEmail,
    linkToken,
    requestOptions,
    creationOptions,
    problemCode,
    registerWith,
    requestRecovery,
    signIn,
    signUp,
    uniqueEmail,
} from './auth-flows';
import { createSoftwareAuthenticator } from './software-authenticator';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

async function session(browser: TestBrowser): Promise<SessionView> {
    const response = await browser.request('GET', '/api/session');
    expect(response.status).toBe(200);
    return response.body as SessionView;
}

async function actorOf(harness: AuthHarness, browser: TestBrowser): Promise<Actor> {
    const view = await session(browser);
    const sessionToken = browser.cookies.get('__Host-ptbk_session') ?? '';
    const record = await harness.store.sessions.find(await sha256Hex(sessionToken));
    const user = await harness.store.accounts.findUserByEmail(view.user.email);
    if (record === null || user === null) {
        throw new Error('no active session');
    }
    return {
        userId: user.id,
        orgId: record.activeOrgId,
        orgRole: 'owner',
        platformRole: user.platformRole,
        recoveredAt: user.recoveredAt,
        steppedUpAt: record.steppedUpAt,
    };
}

/**
 * The D-02 acceptance tests over HTTP, run against the in-memory store (unit project, for coverage) and against D1
 * (workers project). `dump` returns everything the store holds, to prove what is never stored.
 */
export function describeAuthFlows(
    name: string,
    makeHarness: () => AuthHarness,
    dump: (harness: AuthHarness) => Promise<string>,
): void {
    describe(name, () => {
        let harness: AuthHarness;
        let browser: TestBrowser;

        beforeEach(() => {
            harness = makeHarness();
            browser = harness.browser();
        });

        describe('signup', () => {
            it('creates exactly one user, one personal org and one owner membership, and signs in to that org', async () => {
                const { email, verify } = await signUp(harness, browser);
                const user = await harness.store.accounts.findUserByEmail(email);
                expect(user).not.toBeNull();
                expect(user?.emailVerifiedAt).not.toBeNull();
                const memberships = await harness.store.accounts.listMemberships(user?.id ?? never());
                expect(memberships).toHaveLength(1);
                expect(memberships[0]?.role).toBe('owner');
                expect(memberships[0]?.org.kind).toBe('personal');
                const view = verify.body as SessionView;
                expect(view.activeOrg).toMatchObject({ id: memberships[0]?.orgId, kind: 'personal', role: 'owner' });
                expect(view.activeOrg.permissions).toContain('engine.remove');
                expect(view.memberships).toHaveLength(1);
                expect((await session(browser)).user.email).toBe(email);
                const passkeys = await harness.store.passkeys.listForUser(user?.id ?? never());
                expect(passkeys.map((passkey) => passkey.addedVia)).toEqual(['signup']);
                expect(user?.webauthnUserId).toHaveLength(32);
            });

            it('sets a __Host- session cookie: Secure, HttpOnly, Path=/, SameSite=Lax, for 30 days', async () => {
                const { verify } = await signUp(harness, browser);
                const cookie = verify.setCookies.find((value) => value.startsWith('__Host-ptbk_session='));
                expect(cookie).toMatch(
                    /^__Host-ptbk_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
                );
                expect(cookie).not.toMatch(/Domain=/i);
                const challenge = verify.setCookies.find((value) => value.startsWith('__Host-ptbk_chal='));
                expect(challenge).toBe('__Host-ptbk_chal=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict');
            });

            it('answers signup/start identically for new and existing emails, and mails each its own template', async () => {
                const { email: existing } = await signUp(harness, browser);
                const fresh = uniqueEmail();
                const other = harness.browser();
                const first = await other.request('POST', '/api/auth/signup/start', { email: fresh });
                const second = await other.request('POST', '/api/auth/signup/start', { email: existing.toUpperCase() });
                expect(first.status).toBe(202);
                expect(second.status).toBe(202);
                expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body));
                expect(second.setCookies).toEqual(first.setCookies);
                expect(lastEmail(harness, fresh).template).toBe('signup-link');
                const exists = lastEmail(harness, existing);
                expect(exists).toMatchObject({
                    template: 'account-exists',
                    signInLink: `${ORIGIN}/signin`,
                    recoveryLink: `${ORIGIN}/recover`,
                });
            });

            it('rejects an invalid email address without sending anything', async () => {
                const response = await browser.request('POST', '/api/auth/signup/start', { email: 'not-an-email' });
                expect(response.status).toBe(400);
                expect(harness.outbox.sent).toHaveLength(0);
            });

            it('keeps the link usable after a failed ceremony, and single-use after success', async () => {
                const email = uniqueEmail();
                await browser.request('POST', '/api/auth/signup/start', { email });
                const token = linkToken(harness, email);
                const failed = await registerWith(
                    browser,
                    '/api/auth/signup/options',
                    '/api/auth/signup/verify',
                    { token },
                    { origin: 'https://evil.test' },
                );
                expect(failed.verify.status).toBe(401);
                const ok = await registerWith(browser, '/api/auth/signup/options', '/api/auth/signup/verify', {
                    token,
                });
                expect(ok.verify.status).toBe(200);
                const again = await browser.request('POST', '/api/auth/signup/options', { token });
                expect(again.status).toBe(400);
                expect(problemCode(again)).toBe('token-invalid');
            });

            it('rejects the link after 15 minutes, and an older link once a newer one was sent', async () => {
                const email = uniqueEmail();
                await browser.request('POST', '/api/auth/signup/start', { email });
                const old = linkToken(harness, email);
                await browser.request('POST', '/api/auth/signup/start', { email });
                const current = linkToken(harness, email);
                expect(problemCode(await browser.request('POST', '/api/auth/signup/options', { token: old }))).toBe(
                    'token-invalid',
                );
                harness.clock.advance(15 * MINUTE);
                expect(problemCode(await browser.request('POST', '/api/auth/signup/options', { token: current }))).toBe(
                    'token-invalid',
                );
            });

            it('refuses a token whose email has meanwhile signed up', async () => {
                const email = uniqueEmail();
                await browser.request('POST', '/api/auth/signup/start', { email });
                const token = linkToken(harness, email);
                const registration = creationOptions(
                    await browser.request('POST', '/api/auth/signup/options', { token }),
                );
                const response = await browser.authenticator.register(registration);
                // Another tab finishes first with a newer link for the same address.
                const other = harness.browser();
                await other.request('POST', '/api/auth/signup/start', { email });
                const newer = linkToken(harness, email);
                await registerWith(other, '/api/auth/signup/options', '/api/auth/signup/verify', { token: newer });
                const verify = await browser.request('POST', '/api/auth/signup/verify', { token, response });
                expect(verify.status).toBe(400);
                expect(problemCode(verify)).toBe('token-invalid');
            });
        });

        describe('WebAuthn ceremonies', () => {
            async function signupCeremony() {
                const email = uniqueEmail();
                await browser.request('POST', '/api/auth/signup/start', { email });
                const token = linkToken(harness, email);
                const registration = creationOptions(
                    await browser.request('POST', '/api/auth/signup/options', { token }),
                );
                return { token, registration };
            }

            it('offers resident keys with required user verification, no attestation, Ed25519/ES256/RS256', async () => {
                const { registration } = await signupCeremony();
                expect(registration.rp.id).toBe('app.ptbk.test');
                expect(registration.authenticatorSelection).toEqual({
                    residentKey: 'required',
                    requireResidentKey: true,
                    userVerification: 'required',
                });
                expect(registration.attestation).toBe('none');
                expect(registration.pubKeyCredParams.map((param) => param.alg)).toEqual([-8, -7, -257]);
                expect(registration.user.name).not.toBe(registration.user.id);
            });

            it.each([
                ['wrong origin', { origin: 'https://app.ptbk.test.evil.test' }],
                ['wrong rpID', { rpId: 'evil.test' }],
                ['no user verification', { userVerified: false }],
                ['wrong challenge', { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
                ['wrong ceremony type', { type: 'webauthn.get' }],
            ])('rejects a registration with %s', async (_, overrides) => {
                const { token, registration } = await signupCeremony();
                const response = await browser.authenticator.register(registration, overrides);
                const verify = await browser.request('POST', '/api/auth/signup/verify', { token, response });
                expect(verify.status).toBe(401);
                expect(problemCode(verify)).toBe('webauthn-failed');
                expect(verify.setCookies).toContain(
                    '__Host-ptbk_chal=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict',
                );
            });

            it('rejects a second verify with a consumed challenge, even after the first one failed', async () => {
                const { token, registration } = await signupCeremony();
                const challengeCookie = browser.cookies.get('__Host-ptbk_chal') ?? never();
                const bad = await browser.authenticator.register(registration, { origin: 'https://evil.test' });
                expect(
                    (await browser.request('POST', '/api/auth/signup/verify', { token, response: bad })).status,
                ).toBe(401);
                browser.cookies.set('__Host-ptbk_chal', challengeCookie);
                const good = await browser.authenticator.register(registration);
                const verify = await browser.request('POST', '/api/auth/signup/verify', { token, response: good });
                expect(verify.status).toBe(400);
                expect(problemCode(verify)).toBe('challenge-invalid');
            });

            it('rejects a replayed registration', async () => {
                const { token, registration } = await signupCeremony();
                const challengeCookie = browser.cookies.get('__Host-ptbk_chal') ?? never();
                const response = await browser.authenticator.register(registration);
                expect((await browser.request('POST', '/api/auth/signup/verify', { token, response })).status).toBe(
                    200,
                );
                browser.cookies.set('__Host-ptbk_chal', challengeCookie);
                const replay = await browser.request('POST', '/api/auth/signup/verify', { token, response });
                expect(problemCode(replay)).toBe('challenge-invalid');
            });

            it('rejects an expired challenge', async () => {
                const { token, registration } = await signupCeremony();
                harness.clock.advance(5 * MINUTE);
                const response = await browser.authenticator.register(registration);
                const verify = await browser.request('POST', '/api/auth/signup/verify', { token, response });
                expect(problemCode(verify)).toBe('challenge-invalid');
            });

            it('rejects a challenge issued for another purpose or another token', async () => {
                const { token, registration } = await signupCeremony();
                await browser.request('POST', '/api/auth/signin/options');
                const response = await browser.authenticator.register(registration);
                expect(problemCode(await browser.request('POST', '/api/auth/signup/verify', { token, response }))).toBe(
                    'challenge-invalid',
                );

                const second = await signupCeremony();
                const other = await signupCeremony();
                const crossed = await browser.authenticator.register(second.registration);
                expect(
                    problemCode(
                        await browser.request('POST', '/api/auth/signup/verify', {
                            token: second.token,
                            response: crossed,
                        }),
                    ),
                ).toBe('challenge-invalid');
                expect(other.token).not.toBe(second.token);
            });

            it('rejects a verify without the challenge cookie', async () => {
                const { token, registration } = await signupCeremony();
                browser.cookies.delete('__Host-ptbk_chal');
                const response = await browser.authenticator.register(registration);
                expect(problemCode(await browser.request('POST', '/api/auth/signup/verify', { token, response }))).toBe(
                    'challenge-invalid',
                );
            });
        });

        describe('sign-in', () => {
            it('signs in usernamelessly with a new session ID and revokes the session the browser had', async () => {
                const { verify: signup } = await signUp(harness, browser);
                const before = browser.cookies.get('__Host-ptbk_session') ?? never();
                const signin = await signIn(browser);
                expect(signin.verify.status).toBe(200);
                const after = browser.cookies.get('__Host-ptbk_session') ?? never();
                expect(after).not.toBe(before);
                expect((signin.verify.body as SessionView).user.id).toBe((signup.body as SessionView).user.id);
                const old = harness.browser();
                old.cookies.set('__Host-ptbk_session', before);
                expect((await old.request('GET', '/api/session')).status).toBe(401);
            });

            it('offers no allow list, so the browser picks any of its passkeys for this rpID', async () => {
                const authentication = requestOptions(await browser.request('POST', '/api/auth/signin/options'));
                expect(authentication).toMatchObject({
                    rpId: 'app.ptbk.test',
                    allowCredentials: [],
                    userVerification: 'required',
                });
                expect(browser.cookies.has('__Host-ptbk_chal')).toBe(true);
            });

            it.each([
                ['a userHandle that is not the owner’s', { userHandle: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
                ['no userHandle', { userHandle: null }],
                ['wrong origin', { origin: 'https://evil.test' }],
                ['wrong rpID', { rpId: 'evil.test' }],
                ['no user verification', { userVerified: false }],
                ['an unknown credential', { credentialId: 'AAAAAAAAAAAAAAAAAAAAAA' }],
            ])('rejects an assertion with %s with 401', async (_, overrides) => {
                await signUp(harness, browser);
                const signin = await signIn(browser, overrides);
                expect(signin.verify.status).toBe(401);
                expect(problemCode(signin.verify)).toBe('webauthn-failed');
            });

            it('rejects a forged assertion signed by another key', async () => {
                await signUp(harness, browser);
                const attacker = harness.browser();
                await signUp(harness, attacker);
                const victimCredential = browser.authenticator.credentials[0] ?? never();
                const attackerCredential = attacker.authenticator.credentials[0] ?? never();
                const authentication = requestOptions(await attacker.request('POST', '/api/auth/signin/options'));
                const forged = await attacker.authenticator.assert(authentication, {
                    credentialId: toId(victimCredential.id),
                    userHandle: toId(victimCredential.userHandle),
                    signWith: attackerCredential,
                });
                const verify = await attacker.request('POST', '/api/auth/signin/verify', { response: forged });
                expect(verify.status).toBe(401);
            });

            it('rejects a replayed assertion', async () => {
                await signUp(harness, browser);
                const authentication = requestOptions(await browser.request('POST', '/api/auth/signin/options'));
                const challengeCookie = browser.cookies.get('__Host-ptbk_chal') ?? never();
                const response = await browser.authenticator.assert(authentication);
                expect((await browser.request('POST', '/api/auth/signin/verify', { response })).status).toBe(200);
                browser.cookies.set('__Host-ptbk_chal', challengeCookie);
                const replay = await browser.request('POST', '/api/auth/signin/verify', { response });
                expect(problemCode(replay)).toBe('challenge-invalid');
            });

            it('flags a counter that does not grow from a non-zero value, logs it by user ID only, and fails', async () => {
                const { email } = await signUp(harness, browser);
                expect((await signIn(browser)).verify.status).toBe(200);
                const credential = browser.authenticator.credentials[0] ?? never();
                const cloned = await signIn(browser, { counter: credential.counter - 1 });
                expect(cloned.verify.status).toBe(401);
                const user = await harness.store.accounts.findUserByEmail(email);
                const passkey = await harness.store.passkeys.find(toId(credential.id));
                expect(passkey?.counterRegressedAt).toBe(harness.clock.nowMs());
                expect(passkey?.counter).toBe(1);
                const event = harness.logger.entries.find((entry) => entry.event === 'auth.passkey-counter-regression');
                expect(event?.fields).toEqual({ userId: user?.id });
            });

            it('never flags a synced passkey whose counter stays 0', async () => {
                const synced = harness.browser({
                    authenticator: createSoftwareAuthenticator({ origin: ORIGIN, counterStep: 0 }),
                });
                await signUp(harness, synced);
                expect((await signIn(synced)).verify.status).toBe(200);
                expect((await signIn(synced)).verify.status).toBe(200);
                const passkey = await harness.store.passkeys.find(
                    toId(synced.authenticator.credentials[0]?.id ?? never()),
                );
                expect(passkey?.counterRegressedAt).toBeNull();
                expect(harness.logger.entries.map((entry) => entry.event)).not.toContain(
                    'auth.passkey-counter-regression',
                );
            });
        });

        describe('sessions', () => {
            it('answers GET /api/session with 401 without a session or with an unknown one', async () => {
                const none = await browser.request('GET', '/api/session');
                expect(none.status).toBe(401);
                expect(problemCode(none)).toBe('unauthorized');
                browser.cookies.set('__Host-ptbk_session', 'A'.repeat(43));
                expect((await browser.request('GET', '/api/session')).status).toBe(401);
            });

            it('fails on the very next request after sign-out', async () => {
                await signUp(harness, browser);
                const token = browser.cookies.get('__Host-ptbk_session') ?? never();
                const signout = await browser.request('POST', '/api/auth/signout');
                expect(signout.status).toBe(200);
                expect(browser.cookies.has('__Host-ptbk_session')).toBe(false);
                browser.cookies.set('__Host-ptbk_session', token);
                expect((await browser.request('GET', '/api/session')).status).toBe(401);
            });

            it('revokes every session of the user, and only that user, with revoke-all', async () => {
                await signUp(harness, browser);
                const laptop = harness.browser({ authenticator: browser.authenticator });
                expect((await signIn(laptop)).verify.status).toBe(200);
                const stranger = harness.browser();
                await signUp(harness, stranger);
                const listed = await browser.request('GET', '/api/sessions');
                expect((listed.body as { sessions: { current: boolean }[] }).sessions.map((s) => s.current)).toEqual([
                    true,
                    false,
                ]);
                expect((await browser.request('POST', '/api/sessions/revoke-all')).status).toBe(200);
                expect((await laptop.request('GET', '/api/session')).status).toBe(401);
                expect((await browser.request('GET', '/api/session')).status).toBe(401);
                expect((await stranger.request('GET', '/api/session')).status).toBe(200);
            });

            it('expires after 7 idle days and after 30 days whatever the activity', async () => {
                await signUp(harness, browser);
                harness.clock.advance(7 * DAY - MINUTE);
                expect((await browser.request('GET', '/api/session')).status).toBe(200);
                for (let day = 0; day < 23; day++) {
                    harness.clock.advance(DAY);
                    expect((await browser.request('GET', '/api/session')).status).toBe(200);
                }
                harness.clock.advance(DAY);
                expect((await browser.request('GET', '/api/session')).status).toBe(401);

                const idle = harness.browser();
                await signUp(harness, idle);
                harness.clock.advance(7 * DAY);
                expect((await idle.request('GET', '/api/session')).status).toBe(401);
            });
        });

        describe('cross-site requests', () => {
            it.each([
                ['Sec-Fetch-Site: cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
                ['Sec-Fetch-Site: same-site', { 'Sec-Fetch-Site': 'same-site' }],
                ['Sec-Fetch-Site: none', { 'Sec-Fetch-Site': 'none' }],
            ])('refuses a POST with %s with 403', async (_, headers) => {
                await signUp(harness, browser);
                const response = await browser.request('POST', '/api/sessions/revoke-all', undefined, headers);
                expect(response.status).toBe(403);
                expect(problemCode(response)).toBe('forbidden');
                expect((await browser.request('GET', '/api/session')).status).toBe(200);
            });

            it('falls back to Origin without Fetch Metadata: foreign or missing is 403, our own passes', async () => {
                const post = (headers: Record<string, string>) =>
                    harness.http.request(`${ORIGIN}/api/auth/signin/options`, { method: 'POST', headers });
                expect((await post({ Origin: 'https://evil.test' })).status).toBe(403);
                expect((await post({})).status).toBe(403);
                expect((await post({ Origin: ORIGIN })).status).toBe(200);
            });

            it('leaves safe methods alone', async () => {
                await signUp(harness, browser);
                expect(
                    (await browser.request('GET', '/api/session', undefined, { 'Sec-Fetch-Site': 'cross-site' }))
                        .status,
                ).toBe(200);
            });
        });

        describe('passkeys', () => {
            it('adds a second passkey, lists both, removes one and never the last', async () => {
                await signUp(harness, browser);
                const added = await registerWith(browser, '/api/passkeys/options', '/api/passkeys/verify', {});
                expect(added.verify.status).toBe(200);
                expect((added.verify.body as { passkey: { addedVia: string } }).passkey.addedVia).toBe('account');
                const listed = (await browser.request('GET', '/api/passkeys')).body as {
                    passkeys: { credentialId: string; addedVia: string }[];
                };
                expect(listed.passkeys.map((p) => p.addedVia).sort()).toEqual(['account', 'signup']);
                const [first, second] = listed.passkeys;
                expect(
                    (await browser.request('POST', '/api/passkeys/delete', { credentialId: first?.credentialId }))
                        .status,
                ).toBe(200);
                const last = await browser.request('POST', '/api/passkeys/delete', {
                    credentialId: second?.credentialId,
                });
                expect(last.status).toBe(409);
                expect(problemCode(last)).toBe('last-passkey');
                expect(
                    problemCode(
                        await browser.request('POST', '/api/passkeys/delete', { credentialId: first?.credentialId }),
                    ),
                ).toBe('not-found');
            });

            it('excludes the passkeys the account already has', async () => {
                await signUp(harness, browser);
                const registration = creationOptions(await browser.request('POST', '/api/passkeys/options'));
                expect(registration.excludeCredentials.map((d) => d.id)).toEqual([
                    toId(browser.authenticator.credentials[0]?.id ?? never()),
                ]);
            });

            it('refuses a credential that is already registered', async () => {
                await signUp(harness, browser);
                const registration = creationOptions(await browser.request('POST', '/api/passkeys/options'));
                const response = await browser.authenticator.register(registration, {
                    reuse: browser.authenticator.credentials[0] ?? never(),
                });
                const verify = await browser.request('POST', '/api/passkeys/verify', { response });
                expect(verify.status).toBe(409);
                expect(problemCode(verify)).toBe('conflict');
            });

            it('rejects a passkey registration from another origin', async () => {
                await signUp(harness, browser);
                const added = await registerWith(
                    browser,
                    '/api/passkeys/options',
                    '/api/passkeys/verify',
                    {},
                    { origin: 'https://evil.test' },
                );
                expect(added.verify.status).toBe(401);
            });

            it('needs a session for every passkey and session endpoint', async () => {
                for (const [method, path] of [
                    ['GET', '/api/passkeys'],
                    ['POST', '/api/passkeys/options'],
                    ['GET', '/api/sessions'],
                    ['POST', '/api/sessions/revoke-all'],
                    ['POST', '/api/auth/step-up/options'],
                    ['POST', '/api/auth/signout'],
                ] as const) {
                    expect((await browser.request(method, path)).status, path).toBe(401);
                }
            });
        });

        describe('step-up', () => {
            it('sets a fresh step-up with an assertion of one of the user’s own passkeys', async () => {
                await signUp(harness, browser);
                expect((await session(browser)).steppedUpUntil).toBeNull();
                const authentication = requestOptions(await browser.request('POST', '/api/auth/step-up/options'));
                expect(authentication.allowCredentials).toHaveLength(1);
                const response = await browser.authenticator.assert(authentication);
                const verify = await browser.request('POST', '/api/auth/step-up/verify', { response });
                expect(verify.body).toEqual({ steppedUpUntil: harness.clock.nowMs() + 5 * MINUTE });
                expect((await session(browser)).steppedUpUntil).toBe(harness.clock.nowMs() + 5 * MINUTE);
            });

            it('refuses another user’s passkey and a bad assertion', async () => {
                await signUp(harness, browser);
                const other = harness.browser();
                await signUp(harness, other);
                const authentication = requestOptions(await browser.request('POST', '/api/auth/step-up/options'));
                const foreign = await other.authenticator.assert({ ...authentication, allowCredentials: [] });
                expect((await browser.request('POST', '/api/auth/step-up/verify', { response: foreign })).status).toBe(
                    401,
                );
                const again = requestOptions(await browser.request('POST', '/api/auth/step-up/options'));
                const unverified = await browser.authenticator.assert(again, { userVerified: false });
                expect(
                    problemCode(await browser.request('POST', '/api/auth/step-up/verify', { response: unverified })),
                ).toBe('webauthn-failed');
            });

            it('counts a sign-in as a step-up, for five minutes', async () => {
                await signUp(harness, browser);
                await signIn(browser);
                const actor = await actorOf(harness, browser);
                const can = (action: DashboardAction) =>
                    harness.deps.authorizer.can(actor, action, { kind: 'account', userId: actor.userId });
                expect(actor.steppedUpAt).toBe(harness.clock.nowMs());
                expect(can('passkey.manage')).toEqual({ kind: 'allowed' });
            });
        });

        describe('recovery', () => {
            it('mails a 256-bit single-use token that is stored only as its SHA-256', async () => {
                const { email } = await signUp(harness, browser);
                const token = await requestRecovery(harness, harness.browser(), email);
                const bytes = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
                expect(bytes).toHaveLength(32);
                const stored = await harness.store.emailTokens.findUsable(
                    await sha256Hex(token),
                    'recovery',
                    harness.clock.nowMs(),
                );
                expect(stored?.purpose).toBe('recovery');
                expect(await dump(harness)).not.toContain(token);
                expect(lastEmail(harness, email)).toMatchObject({ template: 'recovery-link' });
            });

            it('answers recovery/request byte for byte the same for existing and unknown emails', async () => {
                const { email } = await signUp(harness, browser);
                const other = harness.browser();
                const known = await other.request('POST', '/api/auth/recovery/request', { email });
                const unknown = await other.request('POST', '/api/auth/recovery/request', { email: uniqueEmail() });
                expect(known.status).toBe(unknown.status);
                expect(JSON.stringify(known.body)).toBe(JSON.stringify(unknown.body));
                expect([...known.headers]).toEqual([...unknown.headers]);
                expect(harness.outbox.sent.filter((m) => m.template === 'recovery-link')).toHaveLength(1);
            });

            it('rejects the token after 15 minutes and after use', async () => {
                const { email } = await signUp(harness, browser);
                const stranger = harness.browser();
                const token = await requestRecovery(harness, stranger, email);
                harness.clock.advance(15 * MINUTE);
                expect(problemCode(await stranger.request('POST', '/api/auth/recovery/options', { token }))).toBe(
                    'token-invalid',
                );
                const fresh = await requestRecovery(harness, stranger, email);
                const { verify } = await registerWith(
                    stranger,
                    '/api/auth/recovery/options',
                    '/api/auth/recovery/verify',
                    { token: fresh },
                );
                expect(verify.status).toBe(200);
                expect(
                    problemCode(await stranger.request('POST', '/api/auth/recovery/options', { token: fresh })),
                ).toBe('token-invalid');
            });

            it('authorizes only recovery/options and recovery/verify, and creates no session before the passkey', async () => {
                const { email } = await signUp(harness, browser);
                const stranger = harness.browser();
                const token = await requestRecovery(harness, stranger, email);
                expect(problemCode(await stranger.request('POST', '/api/auth/signup/options', { token }))).toBe(
                    'token-invalid',
                );
                const asCookie = harness.browser();
                asCookie.cookies.set('__Host-ptbk_session', token);
                expect((await asCookie.request('GET', '/api/session')).status).toBe(401);
                expect((await asCookie.request('GET', '/api/passkeys')).status).toBe(401);
                const registration = await stranger.request('POST', '/api/auth/recovery/options', { token });
                expect(registration.status).toBe(200);
                expect(stranger.cookies.has('__Host-ptbk_session')).toBe(false);
                expect((await stranger.request('GET', '/api/session')).status).toBe(401);
                // A signup token is just as useless for recovery.
                const fresh = uniqueEmail();
                await stranger.request('POST', '/api/auth/signup/start', { email: fresh });
                const signupToken = linkToken(harness, fresh);
                expect(
                    problemCode(await stranger.request('POST', '/api/auth/recovery/options', { token: signupToken })),
                ).toBe('token-invalid');
            });

            it('revokes earlier sessions, sends a notice, lists old passkeys as removable and starts the cooldown', async () => {
                const { email } = await signUp(harness, browser);
                const lost = harness.browser();
                const token = await requestRecovery(harness, lost, email);
                const { verify } = await registerWith(lost, '/api/auth/recovery/options', '/api/auth/recovery/verify', {
                    token,
                });
                expect(verify.status).toBe(200);
                const recoveredAt = harness.clock.nowMs();
                expect((verify.body as SessionView).user).toMatchObject({
                    recoveredAt,
                    recoveryCooldownEndsAt: recoveredAt + RECOVERY_COOLDOWN_MS,
                });
                expect((await browser.request('GET', '/api/session')).status).toBe(401);
                expect(lastEmail(harness, email)).toMatchObject({
                    template: 'recovery-notice',
                    recoveredAt,
                    cooldownEndsAt: recoveredAt + RECOVERY_COOLDOWN_MS,
                    signInLink: `${ORIGIN}/signin`,
                });

                const listed = (await lost.request('GET', '/api/passkeys')).body as {
                    passkeys: { credentialId: string; addedVia: string }[];
                };
                expect(listed.passkeys.map((p) => p.addedVia).sort()).toEqual(['recovery', 'signup']);
                const old = listed.passkeys.find((p) => p.addedVia === 'signup');
                expect(
                    (await lost.request('POST', '/api/passkeys/delete', { credentialId: old?.credentialId })).status,
                ).toBe(200);

                const actor = await actorOf(harness, lost);
                const sensitive = ['engine.remove', 'engine.hostnames.manage', 'billing.owner.change'] as const;
                const resource = { kind: 'org', orgId: actor.orgId } as const;
                for (const action of sensitive) {
                    expect(harness.deps.authorizer.can(actor, action, resource)).toEqual({
                        kind: 'denied',
                        reason: 'recovery-cooldown',
                    });
                }
                expect(harness.deps.authorizer.can(actor, 'org.read', resource)).toEqual({ kind: 'allowed' });
                harness.clock.advance(RECOVERY_COOLDOWN_MS);
                for (const action of sensitive) {
                    expect(harness.deps.authorizer.can(actor, action, resource)).toEqual({ kind: 'allowed' });
                }
            });

            it('rejects a recovery ceremony from another origin and keeps the token usable', async () => {
                const { email } = await signUp(harness, browser);
                const lost = harness.browser();
                const token = await requestRecovery(harness, lost, email);
                const failed = await registerWith(
                    lost,
                    '/api/auth/recovery/options',
                    '/api/auth/recovery/verify',
                    { token },
                    { origin: 'https://evil.test' },
                );
                expect(failed.verify.status).toBe(401);
                expect((await browser.request('GET', '/api/session')).status).toBe(200);
                const ok = await registerWith(lost, '/api/auth/recovery/options', '/api/auth/recovery/verify', {
                    token,
                });
                expect(ok.verify.status).toBe(200);
            });

            it('sends nothing for an unknown address', async () => {
                const email = uniqueEmail();
                expect((await browser.request('POST', '/api/auth/recovery/request', { email })).status).toBe(202);
                expect(harness.outbox.sentTo(email)).toEqual([]);
                expect((await browser.request('POST', '/api/auth/recovery/request', { email: 'nope' })).status).toBe(
                    400,
                );
            });
        });

        describe('rate limits', () => {
            it('limits signup/start to 10 per hour per IP with 429', async () => {
                const client = harness.browser({ ip: '198.51.100.7' });
                for (let i = 0; i < 10; i++) {
                    expect(
                        (await client.request('POST', '/api/auth/signup/start', { email: uniqueEmail() })).status,
                    ).toBe(202);
                }
                const limited = await client.request('POST', '/api/auth/signup/start', { email: uniqueEmail() });
                expect(limited.status).toBe(429);
                expect(problemCode(limited)).toBe('rate-limited');
                expect(
                    (
                        await harness
                            .browser({ ip: '198.51.100.8' })
                            .request('POST', '/api/auth/signup/start', { email: uniqueEmail() })
                    ).status,
                ).toBe(202);
                harness.clock.advance(60 * MINUTE);
                expect((await client.request('POST', '/api/auth/signup/start', { email: uniqueEmail() })).status).toBe(
                    202,
                );
            });

            it('limits recovery/request to 10 per hour per IP with 429', async () => {
                const client = harness.browser({ ip: '198.51.100.9' });
                for (let i = 0; i < 10; i++) {
                    await client.request('POST', '/api/auth/recovery/request', { email: uniqueEmail() });
                }
                expect(
                    (await client.request('POST', '/api/auth/recovery/request', { email: uniqueEmail() })).status,
                ).toBe(429);
            });

            it('limits mail to one address to 3 per hour silently: still 202, no email', async () => {
                const { email } = await signUp(harness, browser);
                const before = harness.outbox.sentTo(email).length;
                for (let i = 0; i < 4; i++) {
                    const client = harness.browser({ ip: `203.0.113.${String(i)}` });
                    expect((await client.request('POST', '/api/auth/recovery/request', { email })).status).toBe(202);
                    expect((await client.request('POST', '/api/auth/signup/start', { email })).status).toBe(202);
                }
                const sent = harness.outbox.sentTo(email).slice(before);
                expect(sent.filter((m) => m.template === 'recovery-link')).toHaveLength(3);
                // signUp itself used one of the three signup mails for this address.
                expect(sent.filter((m) => m.template === 'account-exists')).toHaveLength(2);
            });

            it('limits signin/options and the verify endpoints to 30 per minute per IP', async () => {
                const client = harness.browser({ ip: '198.51.100.20' });
                for (let i = 0; i < 30; i++) {
                    await client.request('POST', '/api/auth/signin/options');
                }
                expect((await client.request('POST', '/api/auth/signin/options')).status).toBe(429);

                await signUp(harness, browser);
                const fake = { response: (await signIn(browser)).response };
                for (let i = 0; i < 28; i++) {
                    await browser.request('POST', '/api/auth/signin/verify', fake);
                }
                const limited = await browser.request('POST', '/api/auth/signin/verify', fake);
                expect(limited.status).toBe(429);
                expect(problemCode(await browser.request('POST', '/api/auth/step-up/verify', fake))).toBe(
                    'rate-limited',
                );
                const added = await registerWith(browser, '/api/passkeys/options', '/api/passkeys/verify', {});
                expect(problemCode(added.verify)).toBe('rate-limited');
                const email = uniqueEmail();
                await browser.request('POST', '/api/auth/signup/start', { email });
                const token = linkToken(harness, email);
                const registration = creationOptions(
                    await browser.request('POST', '/api/auth/signup/options', { token }),
                );
                const response = await browser.authenticator.register(registration);
                expect(problemCode(await browser.request('POST', '/api/auth/signup/verify', { token, response }))).toBe(
                    'rate-limited',
                );
                expect(
                    problemCode(await browser.request('POST', '/api/auth/recovery/verify', { token, response })),
                ).toBe('rate-limited');
            });
        });

        describe('isolation between accounts and organizations', () => {
            it('org B cannot read or change org A’s rows', async () => {
                const { email: emailA } = await signUp(harness, browser);
                const other = harness.browser();
                const { email: emailB } = await signUp(harness, other);
                const userA = (await harness.store.accounts.findUserByEmail(emailA)) ?? never();
                const userB = (await harness.store.accounts.findUserByEmail(emailB)) ?? never();
                const orgA = (await session(browser)).activeOrg.id;
                const orgB = (await session(other)).activeOrg.id;
                expect(orgA).not.toBe(orgB);
                expect((await session(other)).memberships.map((m) => m.orgId)).toEqual([orgB]);

                const actorB = await actorOf(harness, other);
                expect(harness.deps.authorizer.can(actorB, 'org.read', { kind: 'org', orgId: actorB.orgId })).toEqual({
                    kind: 'allowed',
                });
                expect(
                    harness.deps.authorizer.can(actorB, 'org.read', {
                        kind: 'org',
                        orgId: (await actorOf(harness, browser)).orgId,
                    }),
                ).toEqual({ kind: 'denied', reason: 'not-member' });
                expect(
                    harness.deps.authorizer.can(actorB, 'passkey.manage', { kind: 'account', userId: userA.id }),
                ).toEqual({
                    kind: 'denied',
                    reason: 'not-self',
                });

                const passkeyA = (await harness.store.passkeys.listForUser(userA.id))[0] ?? never();
                await registerWith(other, '/api/passkeys/options', '/api/passkeys/verify', {});
                const steal = await other.request('POST', '/api/passkeys/delete', {
                    credentialId: passkeyA.credentialId,
                });
                expect(steal.status).toBe(404);
                expect(await harness.store.passkeys.find(passkeyA.credentialId)).not.toBeNull();
                expect(
                    (
                        (await other.request('GET', '/api/passkeys')).body as { passkeys: { credentialId: string }[] }
                    ).passkeys.map((p) => p.credentialId),
                ).not.toContain(passkeyA.credentialId);
                expect(userB.id).not.toBe(userA.id);
            });
        });
    });
}

function toId(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function never(): never {
    throw new Error('unexpected missing value');
}
