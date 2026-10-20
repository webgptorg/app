import { describe, expect, it } from 'vitest';

import { classifyPasskeyError } from './passkey-authenticator';

function domException(name: string): DOMException {
    return new DOMException('browser message', name);
}

function libraryError(code: string, causeName = 'NotAllowedError') {
    return Object.assign(new Error('library message'), { name: 'WebAuthnError', code, cause: domException(causeName) });
}

describe('classifyPasskeyError', () => {
    it.each([
        ['ERROR_CEREMONY_ABORTED', 'cancelled'],
        ['ERROR_INVALID_DOMAIN', 'not-allowed'],
        ['ERROR_INVALID_RP_ID', 'not-allowed'],
        ['ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED', 'already-registered'],
        ['ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT', 'no-authenticator'],
        ['ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT', 'no-authenticator'],
        ['ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG', 'no-authenticator'],
    ])('maps the library code %s to %s, whatever the cause', (code, reason) => {
        expect(classifyPasskeyError(libraryError(code, 'UnknownError'))).toBe(reason);
    });

    it('falls back to the cause for the pass-through code: a closed prompt or "no passkey here" is cancelled', () => {
        expect(classifyPasskeyError(libraryError('ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', 'NotAllowedError'))).toBe(
            'cancelled',
        );
    });

    it.each([
        ['NotAllowedError', 'cancelled'],
        ['AbortError', 'cancelled'],
        ['SecurityError', 'not-allowed'],
        ['InvalidStateError', 'already-registered'],
        ['ConstraintError', 'no-authenticator'],
        ['NotSupportedError', 'no-authenticator'],
    ])('maps a plain %s to %s', (name, reason) => {
        expect(classifyPasskeyError(domException(name))).toBe(reason);
    });

    it.each([
        ['an unknown exception', domException('UnknownError')],
        [
            'an unknown library code with an unknown cause',
            libraryError('ERROR_AUTHENTICATOR_GENERAL_ERROR', 'UnknownError'),
        ],
        ['a string', 'boom'],
        ['null', null],
        ['an object without a name', {}],
    ])('treats %s as failed', (_label, error) => {
        expect(classifyPasskeyError(error)).toBe('failed');
    });
});
