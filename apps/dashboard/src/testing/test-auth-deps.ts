import { createFakeClock, type FakeClock } from '../adapters/fake-clock';
import { createFakeEmailSender, type FakeEmailSender } from '../adapters/email/fake-email-sender';
import { createMemoryLogger, type MemoryLogger } from '../adapters/memory-logger';
import { createMemoryRateLimiter } from '../adapters/rate-limit/memory-rate-limiter';
import { cryptoRandom } from '../adapters/crypto-random';
import type { AuthDeps } from '../domain/auth/auth-deps';
import type { RateLimiter } from '../domain/ports/rate-limiter';
import type { RelyingParty } from '../domain/ports/relying-party';
import { START_MS } from './auth-harness';
import { createMemoryAuthStore } from './memory-auth-store';

/**
 * A relying party that accepts every ceremony, for domain tests of what happens after WebAuthn succeeded. The real
 * verification is tested against the software authenticator in the HTTP flow suite.
 */
export function createAcceptingRelyingParty(credential: { id: string } = { id: 'credential-1' }): RelyingParty {
    return {
        registrationOptions: (input) =>
            Promise.resolve({
                challenge: input.challenge,
                rp: { name: 'Promptbook', id: 'app.ptbk.test' },
                user: { id: 'aGFuZGxl', name: input.userName, displayName: input.userName },
                pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
                timeout: 1,
                attestation: 'none',
                excludeCredentials: [],
                authenticatorSelection: {
                    residentKey: 'required',
                    requireResidentKey: true,
                    userVerification: 'required',
                },
                extensions: { credProps: true },
                hints: [],
            }),
        authenticationOptions: (input) => ({
            challenge: input.challenge,
            timeout: 1,
            rpId: 'app.ptbk.test',
            allowCredentials: [],
            userVerification: 'required',
        }),
        verifyRegistration: () =>
            Promise.resolve({
                kind: 'verified',
                credential: {
                    id: credential.id,
                    publicKey: new Uint8Array([1]),
                    counter: 0,
                    transports: [],
                    backedUp: false,
                    aaguid: null,
                },
            }),
        verifyAuthentication: () => Promise.resolve({ kind: 'verified', newCounter: 0 }),
    };
}

export interface TestAuthDeps extends AuthDeps {
    readonly clock: FakeClock;
    readonly logger: MemoryLogger;
    readonly email: FakeEmailSender;
    readonly store: ReturnType<typeof createMemoryAuthStore>;
}

export function createTestAuthDeps(
    overrides: { readonly relyingParty?: RelyingParty; readonly rateLimiter?: RateLimiter } = {},
): TestAuthDeps {
    const clock = createFakeClock(START_MS);
    return {
        clock,
        random: cryptoRandom,
        logger: createMemoryLogger(),
        store: createMemoryAuthStore(),
        relyingParty: overrides.relyingParty ?? createAcceptingRelyingParty(),
        email: createFakeEmailSender(),
        rateLimiter: overrides.rateLimiter ?? createMemoryRateLimiter(clock),
        links: {
            signup: (token) => `https://app.ptbk.test/signup#${token}`,
            recovery: (token) => `https://app.ptbk.test/recover#${token}`,
            signIn: () => 'https://app.ptbk.test/signin',
            recover: () => 'https://app.ptbk.test/recover',
        },
    };
}
