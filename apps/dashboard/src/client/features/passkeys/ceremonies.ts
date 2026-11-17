import type { RouteContract } from '../../../shared/api/contract';
import { apiRoutes } from '../../../shared/api/routes';
import type { PasskeyView, SessionView } from '../../../shared/api/routes';
import type { ApiClient, ApiOutcome } from '../../api/api-client';
import { ApiError } from '../../api/queries';
import type { ApiFailure } from '../../api/queries';
import type { PasskeyAuthenticator, PasskeyFailure } from './passkey-authenticator';

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
    const options = await deps.api.call(routes.options, { body: { token } });
    if (options.kind !== 'ok') {
        return apiFailure(options);
    }
    const created = await deps.passkeys.register(options.data.options);
    if (created.kind === 'failed') {
        return passkeyFailure(created.reason);
    }
    const verified = await deps.api.call(routes.verify, { body: { token, response: created.response } });
    return verified.kind === 'ok' ? { kind: 'ok', value: verified.data } : apiFailure(verified);
}

/** Usernameless sign-in: the authenticator offers the passkeys it holds for this site. */
export async function signInWithPasskey(deps: CeremonyDeps): Promise<CeremonyResult<SessionView>> {
    const options = await deps.api.call(apiRoutes.signinOptions, {});
    if (options.kind !== 'ok') {
        return apiFailure(options);
    }
    const asserted = await deps.passkeys.authenticate(options.data.options);
    if (asserted.kind === 'failed') {
        return passkeyFailure(asserted.reason);
    }
    const verified = await deps.api.call(apiRoutes.signinVerify, { body: { response: asserted.response } });
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
        const options = await deps.api.call(apiRoutes.inviteJoinOptions, { body });
        if (options.kind !== 'ok') {
            return apiFailure(options);
        }
        const created = await deps.passkeys.register(options.data.options);
        if (created.kind === 'failed') {
            return passkeyFailure(created.reason);
        }
        const verified = await deps.api.call(apiRoutes.inviteJoinVerify, {
            body: { ...body, response: created.response },
        });
        return verified.kind === 'ok' ? { kind: 'ok', value: verified.data } : apiFailure(verified);
    }
    const options = await deps.api.call(apiRoutes.signinOptions, {});
    if (options.kind !== 'ok') {
        return apiFailure(options);
    }
    const asserted = await deps.passkeys.authenticate(options.data.options);
    if (asserted.kind === 'failed') {
        return passkeyFailure(asserted.reason);
    }
    const verified = await deps.api.call(apiRoutes.inviteSigninVerify, {
        body: { ...body, response: asserted.response },
    });
    return verified.kind === 'ok' ? { kind: 'ok', value: verified.data } : apiFailure(verified);
}

/** Adds a passkey to the signed-in account; the authenticator refuses one it already holds for the account. */
export async function addPasskey(deps: CeremonyDeps): Promise<CeremonyResult<PasskeyView>> {
    const options = await deps.api.call(apiRoutes.passkeyOptions, {});
    if (options.kind !== 'ok') {
        return apiFailure(options);
    }
    const created = await deps.passkeys.register(options.data.options);
    if (created.kind === 'failed') {
        return passkeyFailure(created.reason);
    }
    const verified = await deps.api.call(apiRoutes.passkeyVerify, { body: { response: created.response } });
    return verified.kind === 'ok' ? { kind: 'ok', value: verified.data.passkey } : apiFailure(verified);
}

/** A fresh passkey assertion for actions the server guards with `step-up-required`. */
export async function stepUpWithPasskey(deps: CeremonyDeps): Promise<CeremonyResult<number>> {
    const options = await deps.api.call(apiRoutes.stepUpOptions, {});
    if (options.kind !== 'ok') {
        return apiFailure(options);
    }
    const asserted = await deps.passkeys.authenticate(options.data.options);
    if (asserted.kind === 'failed') {
        return passkeyFailure(asserted.reason);
    }
    const verified = await deps.api.call(apiRoutes.stepUpVerify, { body: { response: asserted.response } });
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
