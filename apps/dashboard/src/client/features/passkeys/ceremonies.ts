import type { RouteContract } from '../../../shared/api/contract';
import { apiRoutes } from '../../../shared/api/routes';
import type { PasskeyView, SessionView } from '../../../shared/api/routes';
import type { ApiClient, ApiOutcome } from '../../api/api-client';
import { ApiError } from '../../api/queries';
import type { ApiFailure } from '../../api/queries';
import type { PasskeyAuthenticator, PasskeyFailure, PasskeyOutcome, WaitForPasskey } from './passkey-authenticator';

/** Why a ceremony failed: the browser's half, or the API's answer (`null` when there was no usable answer). */
export type CeremonyFailure =
    | { readonly kind: 'passkey'; readonly reason: PasskeyFailure }
    | { readonly kind: 'api'; readonly code: string | null; readonly outcome: ApiFailure };

export type CeremonyResult<T> =
    { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'failed'; readonly failure: CeremonyFailure };

function apiFailure(outcome: Exclude<ApiOutcome<RouteContract>, { kind: 'ok' }>): CeremonyResult<never> {
    return {
        kind: 'failed',
        failure: { kind: 'api', code: outcome.kind === 'problem' ? outcome.code : null, outcome },
    };
}

function passkeyFailure(reason: PasskeyFailure): CeremonyResult<never> {
    return { kind: 'failed', failure: { kind: 'passkey', reason } };
}

export interface CeremonyDeps {
    readonly api: ApiClient;
    readonly passkeys: PasskeyAuthenticator;
    readonly waitForPrompt?: WaitForPasskey;
}

/** Reopening repeats only options and the credential request. The caller verifies one answer. */
async function requestCredential<Options, Response>(
    getOptions: () => Promise<{ readonly kind: 'ok'; readonly data: { readonly options: Options } } | ApiFailure>,
    open: (options: Options, signal?: AbortSignal) => Promise<PasskeyOutcome<Response>>,
    waitForPrompt?: WaitForPasskey,
): Promise<CeremonyResult<Response>> {
    for (;;) {
        const result = await getOptions();
        if (result.kind !== 'ok') return apiFailure(result);
        const { options } = result.data;
        const answer =
            waitForPrompt === undefined ? await open(options) : await waitForPrompt((signal) => open(options, signal));
        if (answer === 'reopen') continue;
        return answer.kind === 'ok' ? { kind: 'ok', value: answer.response } : passkeyFailure(answer.reason);
    }
}

/**
 * Registers a passkey with an emailed token (`/signup#…` or `/recover#…`) and returns the new session. Every attempt
 * asks for fresh options: the server consumes a challenge on verify, failed or not, and the token only on success.
 */
export async function registerWithEmailToken(
    deps: CeremonyDeps,
    purpose: 'signup' | 'recovery',
    token: string,
): Promise<CeremonyResult<SessionView>> {
    const routes =
        purpose === 'signup'
            ? { options: apiRoutes.signupOptions, verify: apiRoutes.signupVerify }
            : { options: apiRoutes.recoveryOptions, verify: apiRoutes.recoveryVerify };
    const created = await requestCredential(
        () => deps.api.call(routes.options, { body: { token } }),
        deps.passkeys.register.bind(deps.passkeys),
        deps.waitForPrompt,
    );
    if (created.kind === 'failed') return created;
    const verified = await deps.api.call(routes.verify, { body: { token, response: created.value } });
    return verified.kind === 'ok' ? { kind: 'ok', value: verified.data } : apiFailure(verified);
}

/**
 * Usernameless sign-in: the authenticator offers the passkeys it holds for this site, in a prompt or, with `autofill`,
 * in the email field's suggestions once the person picks one there.
 */
export async function signInWithPasskey(
    deps: CeremonyDeps,
    autofill?: AbortSignal,
): Promise<CeremonyResult<SessionView>> {
    const asserted = await requestCredential(
        () => deps.api.call(apiRoutes.signinOptions, {}, autofill),
        autofill === undefined
            ? deps.passkeys.authenticate.bind(deps.passkeys)
            : async (options) =>
                  autofill.aborted
                      ? { kind: 'failed', reason: 'cancelled' }
                      : deps.passkeys.autofill(options, autofill),
        autofill === undefined ? deps.waitForPrompt : undefined,
    );
    // An extension may resolve a cancelled autofill request after the person has opened the explicit picker.
    if (autofill?.aborted) return passkeyFailure('cancelled');
    if (asserted.kind === 'failed') return asserted;
    const verified = await deps.api.call(apiRoutes.signinVerify, { body: { response: asserted.value } });
    return verified.kind === 'ok' ? { kind: 'ok', value: verified.data } : apiFailure(verified);
}

/** What joining from an invitation answers: the new session and where the invitation put the person. */
export interface InviteJoined {
    readonly session: SessionView;
    readonly joined: { readonly orgId: string; readonly teamIds: readonly string[] };
}

/**
 * The invitation page's one step (D-31): for an address without an account, a new passkey creates the account and
 * accepts; for one with an account, a passkey sign-in accepts. Without a token, the server uses the invitation cookie.
 */
export async function joinFromInvite(
    deps: CeremonyDeps,
    mode: 'new-account' | 'sign-in',
    token: string | null,
): Promise<CeremonyResult<InviteJoined>> {
    const body = token === null ? {} : { token };
    if (mode === 'new-account') {
        const created = await requestCredential(
            () => deps.api.call(apiRoutes.inviteJoinOptions, { body }),
            deps.passkeys.register.bind(deps.passkeys),
            deps.waitForPrompt,
        );
        if (created.kind === 'failed') return created;
        const verified = await deps.api.call(apiRoutes.inviteJoinVerify, {
            body: { ...body, response: created.value },
        });
        return verified.kind === 'ok' ? { kind: 'ok', value: verified.data } : apiFailure(verified);
    }
    const asserted = await requestCredential(
        () => deps.api.call(apiRoutes.signinOptions, {}),
        deps.passkeys.authenticate.bind(deps.passkeys),
        deps.waitForPrompt,
    );
    if (asserted.kind === 'failed') return asserted;
    const verified = await deps.api.call(apiRoutes.inviteSigninVerify, {
        body: { ...body, response: asserted.value },
    });
    return verified.kind === 'ok' ? { kind: 'ok', value: verified.data } : apiFailure(verified);
}

/** Adds a passkey to the signed-in account; the authenticator refuses one it already holds for the account. */
export async function addPasskey(deps: CeremonyDeps): Promise<CeremonyResult<PasskeyView>> {
    const created = await requestCredential(
        () => deps.api.call(apiRoutes.passkeyOptions, {}),
        deps.passkeys.register.bind(deps.passkeys),
        deps.waitForPrompt,
    );
    if (created.kind === 'failed') return created;
    const verified = await deps.api.call(apiRoutes.passkeyVerify, { body: { response: created.value } });
    return verified.kind === 'ok' ? { kind: 'ok', value: verified.data.passkey } : apiFailure(verified);
}

/** A fresh passkey assertion for actions the server guards with `step-up-required`. */
export async function stepUpWithPasskey(deps: CeremonyDeps): Promise<CeremonyResult<number>> {
    const asserted = await requestCredential(
        () => deps.api.call(apiRoutes.stepUpOptions, {}),
        deps.passkeys.authenticate.bind(deps.passkeys),
        deps.waitForPrompt,
    );
    if (asserted.kind === 'failed') return asserted;
    const verified = await deps.api.call(apiRoutes.stepUpVerify, { body: { response: asserted.value } });
    return verified.kind === 'ok' ? { kind: 'ok', value: verified.data.steppedUpUntil } : apiFailure(verified);
}

/** The browser's half of a ceremony failed, as an exception for mutation functions. */
export class CeremonyError extends Error {
    readonly reason: PasskeyFailure;

    constructor(reason: PasskeyFailure) {
        super(`Passkey ceremony failed: ${reason}`);
        this.name = 'CeremonyError';
        this.reason = reason;
    }
}

/**
 * For mutation functions: an API answer is rethrown as the {@link ApiError} it was, so `step-up-required`, the recovery
 * cooldown and a lost session are handled like on any other call; a browser failure becomes a {@link CeremonyError}.
 */
export function valueOrThrow<T>(result: CeremonyResult<T>): T {
    if (result.kind === 'ok') {
        return result.value;
    }
    const { failure } = result;
    throw failure.kind === 'api' ? new ApiError(failure.outcome) : new CeremonyError(failure.reason);
}
