import { describe, expect, it } from 'vitest';

import type { CeremonyFailure } from './ceremonies';
import { ceremonyFailureMessage } from './ceremony-messages';

const cases: readonly [CeremonyFailure, 'register' | 'authenticate', RegExp][] = [
    [{ kind: 'passkey', reason: 'cancelled' }, 'register', /^The passkey prompt was closed or timed out/],
    [{ kind: 'passkey', reason: 'cancelled' }, 'authenticate', /found no Promptbook passkey on this device/],
    [{ kind: 'passkey', reason: 'not-allowed' }, 'register', /not allowed to use passkeys/],
    [{ kind: 'passkey', reason: 'no-authenticator' }, 'register', /No passkey can be created on this device/],
    [{ kind: 'passkey', reason: 'already-registered' }, 'register', /already holds a passkey/],
    [{ kind: 'passkey', reason: 'unsupported' }, 'authenticate', /does not support passkeys/],
    [{ kind: 'passkey', reason: 'failed' }, 'authenticate', /^The passkey did not work/],
    [{ kind: 'api', code: null }, 'register', /could not be reached/],
    [{ kind: 'api', code: 'token-invalid' }, 'register', /link no longer works/],
    [{ kind: 'api', code: 'challenge-invalid' }, 'authenticate', /request expired/],
    [{ kind: 'api', code: 'webauthn-failed' }, 'register', /new passkey could not be verified/],
    [{ kind: 'api', code: 'webauthn-failed' }, 'authenticate', /not registered with Promptbook/],
    [{ kind: 'api', code: 'conflict' }, 'register', /already registered/],
    [{ kind: 'api', code: 'rate-limited' }, 'authenticate', /Too many attempts/],
    [{ kind: 'api', code: 'internal' }, 'authenticate', /^The passkey did not work/],
];

describe('ceremonyFailureMessage', () => {
    it.each(cases)('explains %o while trying to %s', (failure, kind, expected) => {
        expect(ceremonyFailureMessage(failure, kind)).toMatch(expected);
    });
});
