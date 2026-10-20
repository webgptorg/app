import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
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

async function run<S extends z.ZodType>(
    schema: S,
    ceremony: () => Promise<unknown>,
): Promise<PasskeyOutcome<z.output<S>>> {
    if (!browserSupportsWebAuthn()) {
        return { kind: 'failed', reason: 'unsupported' };
    }
    try {
        return toOutcome(schema, await ceremony());
    } catch (error) {
        return { kind: 'failed', reason: classifyPasskeyError(error) };
    }
}

export function createBrowserPasskeyAuthenticator(): PasskeyAuthenticator {
    return {
        register: (options) =>
            run(registrationResponseSchema, () =>
                startRegistration({ optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'] }),
            ),
        authenticate: (options) =>
            run(authenticationResponseSchema, () =>
                startAuthentication({
                    optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'],
                }),
            ),
    };
}
