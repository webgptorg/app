import { describe, expect, it } from 'vitest';

import { apiRoutes } from '../../../shared/api/routes';
import { ApiError } from '../../api/queries';
import { createFakePasskeys } from '../../testing/fake-passkeys';
import {
    AUTHENTICATION_OPTIONS,
    AUTHENTICATION_RESPONSE,
    passkey,
    REGISTRATION_OPTIONS,
    REGISTRATION_RESPONSE,
    session,
    TOKEN,
} from '../../testing/fixtures';
import { createScriptedApi, ok, problem } from '../../testing/scripted-api';
import {
    addPasskey,
    CeremonyError,
    registerWithEmailToken,
    signInWithPasskey,
    stepUpWithPasskey,
    valueOrThrow,
} from './ceremonies';

const registration = ok({ options: REGISTRATION_OPTIONS });
const authentication = ok({ options: AUTHENTICATION_OPTIONS });

describe.each(['signup', 'recovery'] as const)('registering with a %s token', (purpose) => {
    const routes =
        purpose === 'signup'
            ? { options: apiRoutes.signupOptions, verify: apiRoutes.signupVerify }
            : { options: apiRoutes.recoveryOptions, verify: apiRoutes.recoveryVerify };

    it('asks for options with the token, registers and verifies, returning the session', async () => {
        const api = createScriptedApi().on(routes.options, registration).on(routes.verify, ok(session()));
        const passkeys = createFakePasskeys();
        expect(await registerWithEmailToken({ api, passkeys }, purpose, TOKEN)).toEqual({
            kind: 'ok',
            value: session(),
        });
        expect(api.callsTo(routes.options)).toEqual([{ body: { token: TOKEN } }]);
        expect(passkeys.register).toHaveBeenCalledWith(REGISTRATION_OPTIONS);
        expect(api.callsTo(routes.verify)).toEqual([{ body: { token: TOKEN, response: REGISTRATION_RESPONSE } }]);
    });

    it('stops at an expired token', async () => {
        const api = createScriptedApi().on(routes.options, problem(400, 'token-invalid'));
        const passkeys = createFakePasskeys();
        expect(await registerWithEmailToken({ api, passkeys }, purpose, TOKEN)).toEqual({
            kind: 'failed',
            failure: apiFailure('token-invalid'),
        });
        expect(passkeys.register).not.toHaveBeenCalled();
    });

    it('stops when the authenticator fails, without verifying', async () => {
        const api = createScriptedApi().on(routes.options, registration);
        const passkeys = createFakePasskeys();
        passkeys.failNext('cancelled');
        expect(await registerWithEmailToken({ api, passkeys }, purpose, TOKEN)).toEqual({
            kind: 'failed',
            failure: { kind: 'passkey', reason: 'cancelled' },
        });
        expect(api.callsTo(routes.verify)).toEqual([]);
    });

    it('reports a refused verification, and no answer at all as code null', async () => {
        const api = createScriptedApi()
            .on(routes.options, registration)
            .once(routes.verify, problem(401, 'webauthn-failed'));
        const passkeys = createFakePasskeys();
        expect(await registerWithEmailToken({ api, passkeys }, purpose, TOKEN)).toEqual({
            kind: 'failed',
            failure: apiFailure('webauthn-failed'),
        });
        expect(await registerWithEmailToken({ api, passkeys }, purpose, TOKEN)).toEqual({
            kind: 'failed',
            failure: apiFailure(null),
        });
    });
});

/** The failure as tests compare it: the code decides, the raw outcome rides along for rethrowing. */
function apiFailure(code: string | null): unknown {
    return expect.objectContaining({ kind: 'api', code });
}

describe('signing in', () => {
    it('authenticates usernameless and returns the session', async () => {
        const api = createScriptedApi()
            .on(apiRoutes.signinOptions, authentication)
            .on(apiRoutes.signinVerify, ok(session()));
        const passkeys = createFakePasskeys();
        expect(await signInWithPasskey({ api, passkeys })).toEqual({ kind: 'ok', value: session() });
        expect(api.callsTo(apiRoutes.signinVerify)).toEqual([{ body: { response: AUTHENTICATION_RESPONSE } }]);
    });

    it('reports each step that fails', async () => {
        const passkeys = createFakePasskeys();
        const noOptions = createScriptedApi().on(apiRoutes.signinOptions, problem(429, 'rate-limited'));
        expect(await signInWithPasskey({ api: noOptions, passkeys })).toEqual({
            kind: 'failed',
            failure: apiFailure('rate-limited'),
        });
        const api = createScriptedApi()
            .on(apiRoutes.signinOptions, authentication)
            .on(apiRoutes.signinVerify, problem(401, 'challenge-invalid'));
        passkeys.failNext('not-allowed');
        expect(await signInWithPasskey({ api, passkeys })).toEqual({
            kind: 'failed',
            failure: { kind: 'passkey', reason: 'not-allowed' },
        });
        expect(await signInWithPasskey({ api, passkeys })).toEqual({
            kind: 'failed',
            failure: apiFailure('challenge-invalid'),
        });
    });
});

describe('adding a passkey', () => {
    it('registers and returns the new passkey', async () => {
        const added = passkey({ addedVia: 'account' });
        const api = createScriptedApi()
            .on(apiRoutes.passkeyOptions, registration)
            .on(apiRoutes.passkeyVerify, ok({ passkey: added }));
        expect(await addPasskey({ api, passkeys: createFakePasskeys() })).toEqual({ kind: 'ok', value: added });
    });

    it('reports each step that fails', async () => {
        const passkeys = createFakePasskeys();
        expect(await addPasskey({ api: createScriptedApi(), passkeys })).toEqual({
            kind: 'failed',
            failure: apiFailure(null),
        });
        const api = createScriptedApi()
            .on(apiRoutes.passkeyOptions, registration)
            .on(apiRoutes.passkeyVerify, problem(409, 'conflict'));
        passkeys.failNext('already-registered');
        expect(await addPasskey({ api, passkeys })).toEqual({
            kind: 'failed',
            failure: { kind: 'passkey', reason: 'already-registered' },
        });
        expect(await addPasskey({ api, passkeys })).toEqual({
            kind: 'failed',
            failure: apiFailure('conflict'),
        });
    });
});

describe('stepping up', () => {
    it('asserts a passkey and returns until when the step-up holds', async () => {
        const api = createScriptedApi()
            .on(apiRoutes.stepUpOptions, authentication)
            .on(apiRoutes.stepUpVerify, ok({ steppedUpUntil: 1234 }));
        expect(await stepUpWithPasskey({ api, passkeys: createFakePasskeys() })).toEqual({ kind: 'ok', value: 1234 });
    });

    it('reports each step that fails', async () => {
        const passkeys = createFakePasskeys();
        expect(await stepUpWithPasskey({ api: createScriptedApi(), passkeys })).toEqual({
            kind: 'failed',
            failure: apiFailure(null),
        });
        const api = createScriptedApi()
            .on(apiRoutes.stepUpOptions, authentication)
            .on(apiRoutes.stepUpVerify, problem(401, 'webauthn-failed'));
        passkeys.failNext('cancelled');
        expect(await stepUpWithPasskey({ api, passkeys })).toEqual({
            kind: 'failed',
            failure: { kind: 'passkey', reason: 'cancelled' },
        });
        expect(await stepUpWithPasskey({ api, passkeys })).toEqual({
            kind: 'failed',
            failure: apiFailure('webauthn-failed'),
        });
    });
});

describe('valueOrThrow', () => {
    it('returns the value, throws a CeremonyError for the browser and the ApiError for the API', () => {
        expect(valueOrThrow({ kind: 'ok', value: 1 })).toBe(1);
        expect(() => valueOrThrow({ kind: 'failed', failure: { kind: 'passkey', reason: 'cancelled' } })).toThrow(
            expect.objectContaining({ name: 'CeremonyError', reason: 'cancelled' }),
        );
        const outcome = { kind: 'problem', status: 403, code: 'step-up-required' } as const;
        let thrown: unknown;
        try {
            valueOrThrow({ kind: 'failed', failure: { kind: 'api', code: 'step-up-required', outcome } });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(ApiError);
        expect((thrown as ApiError).outcome).toEqual(outcome);
        expect(thrown).not.toBeInstanceOf(CeremonyError);
    });
});
