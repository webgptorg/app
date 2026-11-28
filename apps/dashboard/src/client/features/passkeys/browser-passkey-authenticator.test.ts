import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AUTHENTICATION_OPTIONS,
    AUTHENTICATION_RESPONSE,
    REGISTRATION_OPTIONS,
    REGISTRATION_RESPONSE,
} from '../../testing/fixtures';
import { createBrowserPasskeyAuthenticator } from './browser-passkey-authenticator';

const browser = vi.hoisted(() => ({
    browserSupportsWebAuthn: vi.fn(() => true),
    WebAuthnAbortService: { cancelCeremony: vi.fn() },
    startRegistration: vi.fn<(options: unknown) => Promise<unknown>>(),
    startAuthentication: vi.fn<(options: unknown) => Promise<unknown>>(),
}));

vi.mock('@simplewebauthn/browser', () => browser);

describe('the @simplewebauthn/browser authenticator', () => {
    beforeEach(() => {
        browser.browserSupportsWebAuthn.mockReturnValue(true);
        browser.startRegistration.mockReset();
        browser.startAuthentication.mockReset();
    });

    it('reports a browser without WebAuthn as unsupported, without starting a ceremony', async () => {
        browser.browserSupportsWebAuthn.mockReturnValue(false);
        const passkeys = createBrowserPasskeyAuthenticator();
        expect(await passkeys.register(REGISTRATION_OPTIONS)).toEqual({ kind: 'failed', reason: 'unsupported' });
        expect(await passkeys.authenticate(AUTHENTICATION_OPTIONS)).toEqual({ kind: 'failed', reason: 'unsupported' });
        expect(browser.startRegistration).not.toHaveBeenCalled();
    });

    it('passes the options through and drops extension results nobody asked for', async () => {
        browser.startRegistration.mockResolvedValue({
            ...REGISTRATION_RESPONSE,
            clientExtensionResults: { credProps: { rk: true }, prf: { enabled: false } },
        });
        const result = await createBrowserPasskeyAuthenticator().register(REGISTRATION_OPTIONS);
        expect(browser.startRegistration).toHaveBeenCalledWith({ optionsJSON: REGISTRATION_OPTIONS });
        expect(result).toEqual({
            kind: 'ok',
            response: { ...REGISTRATION_RESPONSE, clientExtensionResults: { credProps: { rk: true } } },
        });
    });

    it('cancels the native prompt when its owner aborts', async () => {
        const controller = new AbortController();
        const pending = Promise.withResolvers<unknown>();
        browser.startAuthentication.mockReturnValueOnce(pending.promise);
        const passkeys = createBrowserPasskeyAuthenticator();
        const result = passkeys.authenticate(AUTHENTICATION_OPTIONS, controller.signal);
        await vi.waitFor(() => {
            expect(browser.startAuthentication).toHaveBeenCalledOnce();
        });
        controller.abort();
        expect(browser.WebAuthnAbortService.cancelCeremony).toHaveBeenCalledOnce();
        pending.reject(new DOMException('closed', 'AbortError'));
        expect(await result).toEqual({ kind: 'failed', reason: 'cancelled' });
    });

    it('returns a valid assertion', async () => {
        browser.startAuthentication.mockResolvedValue(AUTHENTICATION_RESPONSE);
        const result = await createBrowserPasskeyAuthenticator().authenticate(AUTHENTICATION_OPTIONS);
        expect(browser.startAuthentication).toHaveBeenCalledWith({ optionsJSON: AUTHENTICATION_OPTIONS });
        expect(result).toEqual({ kind: 'ok', response: AUTHENTICATION_RESPONSE });
    });

    it('refuses a result the API would not accept', async () => {
        browser.startAuthentication.mockResolvedValue({ ...AUTHENTICATION_RESPONSE, type: 'password' });
        expect(await createBrowserPasskeyAuthenticator().authenticate(AUTHENTICATION_OPTIONS)).toEqual({
            kind: 'failed',
            reason: 'failed',
        });
    });

    it('classifies what the ceremony threw', async () => {
        browser.startRegistration.mockRejectedValue(new DOMException('exists', 'InvalidStateError'));
        browser.startAuthentication.mockRejectedValue(new DOMException('closed', 'NotAllowedError'));
        const passkeys = createBrowserPasskeyAuthenticator();
        expect(await passkeys.register(REGISTRATION_OPTIONS)).toEqual({ kind: 'failed', reason: 'already-registered' });
        expect(await passkeys.authenticate(AUTHENTICATION_OPTIONS)).toEqual({ kind: 'failed', reason: 'cancelled' });
    });
});
