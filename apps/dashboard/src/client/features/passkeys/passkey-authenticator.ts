import type {
    AuthenticationOptions,
    AuthenticationResponse,
    RegistrationOptions,
    RegistrationResponse,
} from '../../../shared/api/webauthn';

/**
 * Why the browser's half of a ceremony failed, as the UI explains it. Browsers report the same DOMException for
 * different causes (a closed prompt, a timeout and "no passkey on this device" are all `NotAllowedError`), so the
 * reasons are what we can tell apart, not what happened.
 */
export type PasskeyFailure =
    /** The prompt was closed, timed out or found no passkey for this site; trying again is the remedy. */
    | 'cancelled'
    /** The page may not use WebAuthn here (insecure context, wrong domain, blocked by policy). */
    | 'not-allowed'
    /** No authenticator can make a discoverable, user-verified passkey (no screen lock, unsupported algorithm). */
    | 'no-authenticator'
    /** This authenticator already holds a passkey for the account. */
    | 'already-registered'
    /** The browser has no WebAuthn at all. */
    | 'unsupported'
    | 'failed';

export type PasskeyOutcome<Response> =
    { readonly kind: 'ok'; readonly response: Response } | { readonly kind: 'failed'; readonly reason: PasskeyFailure };

/** The user may replace a modal prompt while the browser is waiting for a credential. */
export type WaitForPasskey = <T>(
    open: (signal: AbortSignal) => Promise<PasskeyOutcome<T>>,
) => Promise<PasskeyOutcome<T> | 'reopen'>;

/** The browser's side of WebAuthn: `@simplewebauthn/browser` in the app, a scripted fake in tests. */
export interface PasskeyAuthenticator {
    register(options: RegistrationOptions, signal?: AbortSignal): Promise<PasskeyOutcome<RegistrationResponse>>;
    authenticate(options: AuthenticationOptions, signal?: AbortSignal): Promise<PasskeyOutcome<AuthenticationResponse>>;
    /** Whether the browser can offer passkeys in an email field's autofill (WebAuthn conditional mediation). */
    supportsAutofill(): Promise<boolean>;
    /**
     * Waits, without a prompt, until the person picks a passkey from the autofill of the field marked
     * `autocomplete="username webauthn"`. Any other ceremony started meanwhile aborts it, as `cancelled`.
     */
    autofill(options: AuthenticationOptions): Promise<PasskeyOutcome<AuthenticationResponse>>;
}

const BY_LIBRARY_CODE: Readonly<Record<string, PasskeyFailure>> = {
    ERROR_CEREMONY_ABORTED: 'cancelled',
    ERROR_INVALID_DOMAIN: 'not-allowed',
    ERROR_INVALID_RP_ID: 'not-allowed',
    ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: 'already-registered',
    ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT: 'no-authenticator',
    ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT: 'no-authenticator',
    ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG: 'no-authenticator',
};

const BY_DOM_EXCEPTION: Readonly<Record<string, PasskeyFailure>> = {
    NotAllowedError: 'cancelled',
    AbortError: 'cancelled',
    SecurityError: 'not-allowed',
    InvalidStateError: 'already-registered',
    ConstraintError: 'no-authenticator',
    NotSupportedError: 'no-authenticator',
};

function field(value: unknown, name: string): unknown {
    return typeof value === 'object' && value !== null && name in value
        ? (value as Readonly<Record<string, unknown>>)[name]
        : undefined;
}

/**
 * The one mapping from what `navigator.credentials` or `@simplewebauthn/browser` threw to a {@link PasskeyFailure}.
 * The library's specific codes win; its pass-through code and plain DOMExceptions fall back to the exception name.
 */
export function classifyPasskeyError(error: unknown): PasskeyFailure {
    const code = field(error, 'code');
    if (typeof code === 'string' && code in BY_LIBRARY_CODE) {
        return BY_LIBRARY_CODE[code] ?? 'failed';
    }
    const cause = field(error, 'cause');
    for (const candidate of [cause, error]) {
        const name = field(candidate, 'name');
        if (typeof name === 'string' && name in BY_DOM_EXCEPTION) {
            return BY_DOM_EXCEPTION[name] ?? 'failed';
        }
    }
    return 'failed';
}
