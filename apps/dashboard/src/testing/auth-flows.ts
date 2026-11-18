import { expect } from 'vitest';

import type { EmailMessage } from '../domain/ports/email-sender';
import type {
    AuthenticationOptions,
    RegistrationOptions,
    RegistrationResponse,
    AuthenticationResponse,
} from '../shared/api/webauthn';
import type { AuthHarness, TestBrowser, TestResponse } from './auth-harness';
import type { AssertionOverrides, CeremonyOverrides } from './software-authenticator';

let counter = 0;

/** A fresh address per call, so suites sharing one D1 database never collide. */
export function uniqueEmail(label = 'person'): string {
    counter++;
    return `${label}-${String(counter)}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}

export function lastEmail(harness: AuthHarness, to: string): EmailMessage {
    const message = harness.outbox.sentTo(to).at(-1);
    if (message === undefined) {
        throw new Error('no email was sent');
    }
    return message;
}

/** The token from the newest signup or recovery link to `to`, read from the fragment as the SPA does. */
export function linkToken(harness: AuthHarness, to: string): string {
    const message = lastEmail(harness, to);
    if (
        message.template !== 'signup-link' &&
        message.template !== 'recovery-link' &&
        message.template !== 'invite-passkey-link'
    ) {
        throw new Error(`expected a link email, got ${message.template}`);
    }
    const token = new URL(message.link).hash.slice(1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return token;
}

export function creationOptions(response: TestResponse): RegistrationOptions {
    expect(response.status).toBe(200);
    return (response.body as { options: RegistrationOptions }).options;
}

export function requestOptions(response: TestResponse): AuthenticationOptions {
    expect(response.status).toBe(200);
    return (response.body as { options: AuthenticationOptions }).options;
}

export function problemCode(response: TestResponse): string {
    return (response.body as { code: string }).code;
}

export async function registerWith(
    browser: TestBrowser,
    optionsPath: string,
    verifyPath: string,
    body: Readonly<Record<string, unknown>>,
    overrides: CeremonyOverrides = {},
): Promise<{ readonly verify: TestResponse; readonly response: RegistrationResponse }> {
    const registration = creationOptions(await browser.request('POST', optionsPath, body));
    const response = await browser.authenticator.register(registration, overrides);
    const verify = await browser.request('POST', verifyPath, { ...body, response });
    return { verify, response };
}

export async function signUp(
    harness: AuthHarness,
    browser: TestBrowser,
    email = uniqueEmail(),
): Promise<{ readonly email: string; readonly verify: TestResponse }> {
    expect((await browser.request('POST', '/api/auth/signup/start', { email })).status).toBe(202);
    const token = linkToken(harness, email);
    const { verify } = await registerWith(browser, '/api/auth/signup/options', '/api/auth/signup/verify', { token });
    expect(verify.status).toBe(200);
    return { email, verify };
}

export async function signIn(
    browser: TestBrowser,
    overrides: AssertionOverrides = {},
): Promise<{ readonly verify: TestResponse; readonly response: AuthenticationResponse }> {
    const authentication = requestOptions(await browser.request('POST', '/api/auth/signin/options'));
    const response = await browser.authenticator.assert(authentication, overrides);
    const verify = await browser.request('POST', '/api/auth/signin/verify', { response });
    return { verify, response };
}

export async function requestRecovery(harness: AuthHarness, browser: TestBrowser, email: string): Promise<string> {
    expect((await browser.request('POST', '/api/auth/recovery/request', { email })).status).toBe(202);
    return linkToken(harness, email);
}
