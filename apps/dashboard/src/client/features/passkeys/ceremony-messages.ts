import { m } from '../../../paraglide/messages';
import type { CeremonyFailure } from './ceremonies';
import type { PasskeyFailure } from './passkey-authenticator';

/** Registering a passkey (sign-up, recovery, adding one) or using one (sign-in, step-up). */
export type CeremonyKind = 'register' | 'authenticate';

function passkeyMessage(reason: PasskeyFailure, kind: CeremonyKind): string {
    switch (reason) {
        case 'cancelled':
            return kind === 'register'
                ? m.passkey_error_cancelled_register()
                : m.passkey_error_cancelled_authenticate();
        case 'not-allowed':
            return m.passkey_error_not_allowed();
        case 'no-authenticator':
            return m.passkey_error_no_authenticator();
        case 'already-registered':
            return m.passkey_error_already_registered();
        case 'unsupported':
            return m.passkey_error_unsupported();
        case 'failed':
            return m.passkey_error_failed();
    }
}

function apiMessage(code: string | null, kind: CeremonyKind): string {
    switch (code) {
        case null:
            return m.api_error_unreachable();
        case 'token-invalid':
            return m.passkey_error_token_invalid();
        case 'challenge-invalid':
            return m.passkey_error_challenge_expired();
        case 'webauthn-failed':
            return kind === 'register'
                ? m.passkey_error_not_verified_register()
                : m.passkey_error_not_verified_authenticate();
        case 'conflict':
            return m.passkey_error_conflict();
        case 'rate-limited':
            return m.api_error_rate_limited();
        default:
            return m.passkey_error_failed();
    }
}

/** The one place a failed ceremony becomes words; every screen shows these with a retry. */
export function ceremonyFailureMessage(failure: CeremonyFailure, kind: CeremonyKind): string {
    return failure.kind === 'passkey' ? passkeyMessage(failure.reason, kind) : apiMessage(failure.code, kind);
}
