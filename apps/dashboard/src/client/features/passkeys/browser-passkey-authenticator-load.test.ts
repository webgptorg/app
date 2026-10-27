import { describe, expect, it, vi } from 'vitest';

import { AUTHENTICATION_OPTIONS } from '../../testing/fixtures';
import { createBrowserPasskeyAuthenticator } from './browser-passkey-authenticator';

vi.mock('@simplewebauthn/browser', () => {
    throw new TypeError('Failed to fetch dynamically imported module');
});

describe('the @simplewebauthn/browser authenticator, when its chunk fails to load', () => {
    it('fails the ceremony instead of throwing', async () => {
        expect(await createBrowserPasskeyAuthenticator().authenticate(AUTHENTICATION_OPTIONS)).toEqual({
            kind: 'failed',
            reason: 'failed',
        });
    });
});
