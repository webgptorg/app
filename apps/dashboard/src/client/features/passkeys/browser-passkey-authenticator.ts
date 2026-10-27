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
): Promise<PasskeyOutcome<z.output<S>>> {
    try {
        const webAuthn = await import('@simplewebauthn/browser');
        if (!webAuthn.browserSupportsWebAuthn()) {
            return { kind: 'failed', reason: 'unsupported' };
        }
        return toOutcome(schema, await ceremony(webAuthn));
    } catch (error) {
        return { kind: 'failed', reason: classifyPasskeyError(error) };
    }
}

export function createBrowserPasskeyAuthenticator(): PasskeyAuthenticator {
    return {
        register: (options) =>
            run(registrationResponseSchema, (webAuthn) =>
                webAuthn.startRegistration({
                    optionsJSON: options as Parameters<typeof WebAuthnBrowser.startRegistration>[0]['optionsJSON'],
                }),
            ),
        authenticate: (options) =>
            run(authenticationResponseSchema, (webAuthn) =>
                webAuthn.startAuthentication({
                    optionsJSON: options as Parameters<typeof WebAuthnBrowser.startAuthentication>[0]['optionsJSON'],
                }),
            ),
    };
}
