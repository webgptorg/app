import type { PasskeyCeremonies, RelyingParty } from '../domain/gateway/passkey-ceremonies';

/**
 * A stand-in authenticator and verifier: options carry the challenge, and a "response" is a plain object naming the
 * challenge and credential it answers. It enforces what the gateway relies on (challenge consumed, origin and RP ID
 * matching, the credential the assertion claims), so unit tests can drive every outcome without a browser; the real
 * signatures are checked by the browser test against `@simplewebauthn/server`.
 */
export interface FakeCeremonies extends PasskeyCeremonies {
    /** What a browser would send after creating a passkey for `options`. */
    register(options: unknown, credentialId: string, rp: RelyingParty): FakeResponse;
    /** What a browser would send after signing `options` with `credentialId`. */
    assert(options: unknown, credentialId: string, rp: RelyingParty): FakeResponse;
}

export interface FakeResponse {
    readonly fake: 'registration' | 'assertion';
    readonly challenge: string;
    readonly credentialId: string;
    readonly origin: string;
    readonly rpId: string;
}

function challengeOf(options: unknown): string {
    const challenge = (options as { challenge?: unknown }).challenge;
    if (typeof challenge !== 'string') throw new Error('options without a challenge');
    return challenge;
}

function responseOf(response: unknown, kind: FakeResponse['fake']): FakeResponse | null {
    if (typeof response !== 'object' || response === null) return null;
    const candidate = response as Partial<FakeResponse>;
    return candidate.fake === kind &&
        typeof candidate.challenge === 'string' &&
        typeof candidate.credentialId === 'string'
        ? (candidate as FakeResponse)
        : null;
}

export function createFakeCeremonies(): FakeCeremonies {
    return {
        registrationOptions: ({ rp, challenge, excludeCredentialIds }) =>
            Promise.resolve({ rp: rp.id, challenge, excludeCredentials: excludeCredentialIds }),
        verifyRegistration({ rp, response, expectChallenge }) {
            const parsed = responseOf(response, 'registration');
            if (parsed === null || parsed.origin !== rp.origin || parsed.rpId !== rp.id) return Promise.resolve(null);
            if (!expectChallenge(parsed.challenge)) return Promise.resolve(null);
            return Promise.resolve({
                credentialId: parsed.credentialId,
                publicKey: 'cHVibGljLWtleQ',
                counter: 0,
                transports: ['internal'],
                attachment: 'platform',
                backedUp: true,
            });
        },
        authenticationOptions: ({ rp, challenge, allowCredentialIds }) =>
            Promise.resolve({ rpId: rp.id, challenge, allowCredentials: allowCredentialIds }),
        credentialIdOf: (response) => responseOf(response, 'assertion')?.credentialId ?? null,
        verifyAuthentication({ rp, response, credential, expectChallenge }) {
            const parsed = responseOf(response, 'assertion');
            if (parsed?.credentialId !== credential.credentialId) return Promise.resolve(null);
            if (parsed.origin !== rp.origin || parsed.rpId !== rp.id) return Promise.resolve(null);
            if (!expectChallenge(parsed.challenge)) return Promise.resolve(null);
            return Promise.resolve({ counter: credential.counter + 1, backedUp: credential.backedUp });
        },
        register: (options, credentialId, rp) => ({
            fake: 'registration',
            challenge: challengeOf(options),
            credentialId,
            origin: rp.origin,
            rpId: rp.id,
        }),
        assert: (options, credentialId, rp) => ({
            fake: 'assertion',
            challenge: challengeOf(options),
            credentialId,
            origin: rp.origin,
            rpId: rp.id,
        }),
    };
}
