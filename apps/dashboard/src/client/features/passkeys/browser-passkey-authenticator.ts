import type * as WebAuthnBrowser from '@simplewebauthn/browser';
import type { z } from 'zod';

import { authenticationResponseSchema, registrationResponseSchema } from '../../../shared/api/webauthn';
import { parseTolerantly } from '../../api/tolerant-parse';
import { classifyPasskeyError } from './passkey-authenticator';
import type { PasskeyAuthenticator, PasskeyOutcome } from './passkey-authenticator';

/**
 * Narrows what the browser produced to the shape the API accepts. The API's schemas are strict; a newer browser may
 * add client extension results nobody asked for, and those are unsigned, so dropping them is safe.
 */
function toOutcome<S extends z.ZodType>(schema: S, value: unknown): PasskeyOutcome<z.output<S>> {
    const parsed = parseTolerantly(schema, value);
    return parsed.success ? { kind: 'ok', response: parsed.data } : { kind: 'failed', reason: 'failed' };
}

/**
 * Loaded on the first ceremony so it stays out of the entry chunk. Every ceremony already awaits its options from the
 * API before this runs, so the import adds no new break in user activation.
 */
async function run<S extends z.ZodType>(
    schema: S,
    ceremony: (webAuthn: typeof WebAuthnBrowser) => Promise<unknown>,
    signal?: AbortSignal,
): Promise<PasskeyOutcome<z.output<S>>> {
    try {
        const webAuthn = await import('@simplewebauthn/browser');
        if (!webAuthn.browserSupportsWebAuthn()) {
            return { kind: 'failed', reason: 'unsupported' };
        }
        if (signal?.aborted) return { kind: 'failed', reason: 'cancelled' };
        const cancel = () => {
            webAuthn.WebAuthnAbortService.cancelCeremony();
        };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            return toOutcome(schema, await ceremony(webAuthn));
        } finally {
            signal?.removeEventListener('abort', cancel);
        }
    } catch (error) {
        return { kind: 'failed', reason: classifyPasskeyError(error) };
    }
}

export function createBrowserPasskeyAuthenticator(): PasskeyAuthenticator {
    return {
        register: (options, signal) =>
            run(
                registrationResponseSchema,
                (webAuthn) =>
                    webAuthn.startRegistration({
                        optionsJSON: options as Parameters<typeof WebAuthnBrowser.startRegistration>[0]['optionsJSON'],
                    }),
                signal,
            ),
        authenticate: (options, signal) =>
            run(
                authenticationResponseSchema,
                (webAuthn) =>
                    webAuthn.startAuthentication({
                        optionsJSON: options as Parameters<
                            typeof WebAuthnBrowser.startAuthentication
                        >[0]['optionsJSON'],
                    }),
                signal,
            ),
        supportsAutofill: async () => {
            try {
                const webAuthn = await import('@simplewebauthn/browser');
                return await webAuthn.browserSupportsWebAuthnAutofill();
            } catch {
                return false;
            }
        },
        // The library aborts this request itself when a modal ceremony starts (its WebAuthnAbortService).
        autofill: (options) =>
            run(authenticationResponseSchema, (webAuthn) =>
                webAuthn.startAuthentication({
                    optionsJSON: options as Parameters<typeof WebAuthnBrowser.startAuthentication>[0]['optionsJSON'],
                    useBrowserAutofill: true,
                }),
            ),
    };
}
