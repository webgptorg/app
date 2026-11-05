import type { WalletRecordId, WalletRequestId } from '@ptbk/engine-api';

import { unwrap } from '../../app/api-errors';
import type { ApiFailure } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useStepUpAwareMutation } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import type { OneTimeValue } from './one-time-value';
import { siteName } from './wallet-origin';
import { walletKeys } from './wallet-queries';

/** Mutations are not cancelled by navigation, so they carry their own timeout instead of a component's signal. */
const MUTATION_TIMEOUT_MS = 30_000;

const INVALIDATES = [walletKeys.all] as const;

/** Saving and removing a login need a fresh passkey; these name what the page reopens on return from step-up. */
export const SAVE_LOGIN_ACTION = 'wallet.save-login';
export const REMOVE_LOGIN_ACTION = 'wallet.remove-login';

export interface LoginInput {
    /** Absent for a new login. */
    readonly recordId?: WalletRecordId;
    readonly origin: string;
    readonly username: string;
    readonly password: OneTimeValue;
    readonly label?: string;
    /** Requested additional fields; each value is handed over once, like the password. */
    readonly fields?: readonly { readonly label: string; readonly value: OneTimeValue }[];
    /** The agent request this answers, so its work resumes. */
    readonly requestId?: WalletRequestId;
}

/** The request or login a mutation acts on; the site is for messages only. */
export interface RequestTarget {
    readonly id: WalletRequestId;
    readonly step: number;
    readonly origin: string;
}

export interface LoginTarget {
    readonly id: WalletRecordId;
    readonly label: string;
}

function notReady(failure: ApiFailure): boolean {
    return failure.kind === 'problem' && failure.problem.code === 'wallet-not-ready';
}

function moved(failure: ApiFailure): boolean {
    return failure.kind === 'problem' && failure.problem.code === 'wallet-request-moved';
}

/**
 * Every change to the Wallet. Saving and removing a login may answer `step-up-required`; the passkey prompt then
 * takes over, and the page reopens the form or the question on return. None is optimistic: the engine decides what a save resolves, and the page shows that only
 * once it answered. Toasts name the site, never a username or a password.
 */
export function useWalletMutations() {
    const engineApi = useEngineApi();
    const signal = () => AbortSignal.timeout(MUTATION_TIMEOUT_MS);

    const save = useStepUpAwareMutation({
        mutationFn: async ({ recordId, origin, username, password, label, fields, requestId }: LoginInput) => {
            const body = {
                origin,
                username,
                password: password.take(),
                ...(label === undefined ? {} : { label }),
                ...(fields === undefined || fields.length === 0
                    ? {}
                    : { fields: fields.map((field) => ({ label: field.label, value: field.value.take() })) }),
                ...(requestId === undefined ? {} : { requestId }),
            };
            return unwrap(
                recordId === undefined
                    ? await engineApi.wallet.add(body, signal())
                    : await engineApi.wallet.update(recordId, body, signal()),
            );
        },
        invalidates: INVALIDATES,
        // Only what reopens the form: the password stays behind and is typed again after the passkey check.
        resumeAs: {
            action: SAVE_LOGIN_ACTION,
            data: ({ recordId, requestId, origin, username, label }: LoginInput) => ({
                ...(recordId === undefined ? {} : { recordId }),
                ...(requestId === undefined ? {} : { requestId }),
                origin,
                username,
                ...(label === undefined ? {} : { label }),
            }),
        },
        successMessage: (saved, { origin }) =>
            saved.resolvedRequestIds.length > 0
                ? m.wallet_saved_resolved({ site: siteName(origin) })
                : m.wallet_saved({ site: siteName(origin) }),
        errorMessage: (failure, { origin }) =>
            notReady(failure) ? m.wallet_not_ready_failure() : m.wallet_save_failed({ site: siteName(origin) }),
    });

    const remove = useStepUpAwareMutation({
        mutationFn: async ({ id }: LoginTarget) => unwrap(await engineApi.wallet.delete(id, signal())),
        invalidates: INVALIDATES,
        resumeAs: { action: REMOVE_LOGIN_ACTION, data: ({ id }: LoginTarget) => ({ recordId: id }) },
        successMessage: (_, { label }) => m.wallet_removed({ label }),
        errorMessage: (failure, { label }) =>
            notReady(failure) ? m.wallet_not_ready_failure() : m.wallet_remove_failed({ label }),
    });

    const markSeen = useStepUpAwareMutation({
        mutationFn: async ({ id, step }: RequestTarget) =>
            unwrap(await engineApi.wallet.markSeen(id, { step }, signal())),
        invalidates: INVALIDATES,
        errorMessage: (failure, { origin }) =>
            moved(failure) ? m.wallet_request_moved() : m.wallet_seen_failed({ site: siteName(origin) }),
    });

    const reject = useStepUpAwareMutation({
        mutationFn: async ({ id, step }: RequestTarget) =>
            unwrap(await engineApi.wallet.reject(id, { step }, signal())),
        invalidates: INVALIDATES,
        successMessage: (_, { origin }) => m.wallet_rejected({ site: siteName(origin) }),
        errorMessage: (failure, { origin }) =>
            moved(failure) ? m.wallet_request_moved() : m.wallet_reject_failed({ site: siteName(origin) }),
    });

    return { save, remove, markSeen, reject };
}

export type WalletMutations = ReturnType<typeof useWalletMutations>;
