import { vi } from 'vitest';
import type { Mock } from 'vitest';

import type {
    AuthenticationOptions,
    AuthenticationResponse,
    RegistrationOptions,
    RegistrationResponse,
} from '../../shared/api/webauthn';
import type { PasskeyAuthenticator, PasskeyFailure, PasskeyOutcome } from '../features/passkeys/passkey-authenticator';
import { AUTHENTICATION_RESPONSE, REGISTRATION_RESPONSE } from './fixtures';

export interface FakePasskeys extends PasskeyAuthenticator {
    readonly register: Mock<(options: RegistrationOptions) => Promise<PasskeyOutcome<RegistrationResponse>>>;
    readonly authenticate: Mock<(options: AuthenticationOptions) => Promise<PasskeyOutcome<AuthenticationResponse>>>;
    /** Off by default, so screens behave as in a browser without passkey autofill. */
    readonly supportsAutofill: Mock<() => Promise<boolean>>;
    /** By default the person never picks a passkey from the autofill: the promise stays pending. */
    readonly autofill: Mock<(options: AuthenticationOptions) => Promise<PasskeyOutcome<AuthenticationResponse>>>;
    /** The next ceremonies fail with these reasons, in order; afterwards they succeed again. */
    failNext(...reasons: PasskeyFailure[]): void;
}

/** A scripted authenticator: succeeds with fixed responses unless told to fail. */
export function createFakePasskeys(): FakePasskeys {
    const failures: PasskeyFailure[] = [];
    const next = <T>(response: T): Promise<PasskeyOutcome<T>> => {
        const reason = failures.shift();
        return Promise.resolve(reason === undefined ? { kind: 'ok', response } : { kind: 'failed', reason });
    };
    return {
        register: vi.fn(() => next(REGISTRATION_RESPONSE)),
        authenticate: vi.fn(() => next(AUTHENTICATION_RESPONSE)),
        supportsAutofill: vi.fn(() => Promise.resolve(false)),
        autofill: vi.fn(() => new Promise<never>(() => undefined)),
        failNext: (...reasons) => {
            failures.push(...reasons);
        },
    };
}
