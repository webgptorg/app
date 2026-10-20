import { describe, expect, it } from 'vitest';

import type { AuthenticationResponse, RegistrationResponse } from '../../shared/api/webauthn';
import { createAcceptingRelyingParty, createTestAuthDeps, type TestAuthDeps } from '../../testing/test-auth-deps';
import { createAccountFlows } from './account';
import { emailAddressSchema } from './email-address';
import { createRecoveryFlow } from './recovery';
import { sha256Hex } from './secrets';
import { createSignInFlow } from './signin';
import { createSignupFlow } from './signup';

// The HTTP flow suite (test/http) covers these flows end to end with real WebAuthn; this file covers the states a
// browser cannot produce: rows that vanished between two steps, and a store that refuses a write.

const registration = { id: 'credential-1' } as unknown as RegistrationResponse;
const assertion = (id: string, userHandle?: string) =>
    ({ id, response: userHandle === undefined ? {} : { userHandle } }) as unknown as AuthenticationResponse;
const email = emailAddressSchema.parse('person@example.test');

async function signedUp(deps: TestAuthDeps) {
    const signup = createSignupFlow(deps);
    await signup.start({ email, locale: 'en' })();
    const message = deps.email.sentTo(email).at(-1);
    const token = message?.template === 'signup-link' ? new URL(message.link).hash.slice(1) : '';
    const options = await signup.options({ token });
    const challengeId = options.kind === 'ok' ? options.challengeId : null;
    const outcome = await signup.verify({ token, challengeId, response: registration, locale: 'en' });
    if (outcome.kind !== 'ok') {
        throw new Error(outcome.kind);
    }
    const user = await deps.store.accounts.findUserByEmail(email);
    if (user === null) {
        throw new Error('no user');
    }
    return { session: outcome.session, user };
}

describe('auth flows when state changes underneath', () => {
    it('signup reports a conflict when the store refuses the account', async () => {
        const deps = createTestAuthDeps();
        await deps.store.passkeys.add({
            credentialId: 'credential-1',
            userId: 'x'.repeat(26) as never,
            publicKey: new Uint8Array(),
            counter: 0,
            transports: [],
            backedUp: false,
            addedVia: 'account',
            createdAt: 0,
            lastUsedAt: null,
            counterRegressedAt: null,
        });
        await expect(signedUp(deps)).rejects.toThrow('conflict');
    });

    it('a session whose membership is gone does not resolve', async () => {
        const deps = createTestAuthDeps();
        const { session } = await signedUp(deps);
        deps.store.state.memberships.length = 0;
        expect(await createAccountFlows(deps).resolveSession(session.token)).toBeNull();
    });

    it('sign-in fails for a passkey whose user is gone, or a user without any organization', async () => {
        const deps = createTestAuthDeps();
        const { user } = await signedUp(deps);
        const signIn = createSignInFlow(deps);
        const handle = btoa(String.fromCharCode(...user.webauthnUserId))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        const attempt = async () => {
            const { challengeId } = await signIn.options();
            return signIn.verify({
                challengeId,
                response: assertion('credential-1', handle),
                previousSessionToken: null,
            });
        };
        deps.store.state.memberships.length = 0;
        expect((await attempt()).kind).toBe('webauthn-failed');
        deps.store.state.users.clear();
        expect((await attempt()).kind).toBe('webauthn-failed');
    });

    it('passkey and step-up ceremonies without a challenge cookie are refused', async () => {
        const deps = createTestAuthDeps();
        const { session, user } = await signedUp(deps);
        const account = createAccountFlows(deps);
        expect((await account.addPasskey({ userId: user.id, challengeId: null, response: registration })).kind).toBe(
            'challenge-invalid',
        );
        expect(
            (await account.stepUp({ session: session.record, challengeId: null, response: assertion('credential-1') }))
                .kind,
        ).toBe('challenge-invalid');
    });

    describe('recovery', () => {
        async function recoveryToken(deps: TestAuthDeps) {
            await createRecoveryFlow(deps).request({ email })();
            const message = deps.email.sentTo(email).at(-1);
            return message?.template === 'recovery-link' ? new URL(message.link).hash.slice(1) : '';
        }

        async function verifyRecovery(deps: TestAuthDeps, token: string) {
            const recovery = createRecoveryFlow(deps);
            const options = await recovery.options({ token });
            const challengeId = options.kind === 'ok' ? options.challengeId : null;
            return recovery.verify({ token, challengeId, response: registration });
        }

        it('refuses a missing challenge', async () => {
            const deps = createTestAuthDeps();
            await signedUp(deps);
            const token = await recoveryToken(deps);
            const outcome = await createRecoveryFlow(deps).verify({ token, challengeId: null, response: registration });
            expect(outcome.kind).toBe('challenge-invalid');
        });

        it('refuses a challenge bound to another user than the token’s', async () => {
            const deps = createTestAuthDeps();
            await signedUp(deps);
            const token = await recoveryToken(deps);
            await deps.store.challenges.create(
                {
                    id: 'c'.repeat(43),
                    challenge: 'x',
                    purpose: 'recovery',
                    userId: 'z'.repeat(26) as never,
                    tokenHash: await sha256Hex(token),
                    webauthnUserId: null,
                    expiresAt: deps.clock.nowMs() + 1000,
                },
                deps.clock.nowMs(),
            );
            const outcome = await createRecoveryFlow(deps).verify({
                token,
                challengeId: 'c'.repeat(43),
                response: registration,
            });
            expect(outcome.kind).toBe('token-invalid');
        });

        it('reports a conflict for a user without an organization or a credential that already exists', async () => {
            const withoutOrg = createTestAuthDeps({
                relyingParty: createAcceptingRelyingParty({ id: 'credential-2' }),
            });
            await signedUp({ ...withoutOrg, relyingParty: createAcceptingRelyingParty() });
            const token = await recoveryToken(withoutOrg);
            withoutOrg.store.state.memberships.length = 0;
            expect((await verifyRecovery(withoutOrg, token)).kind).toBe('conflict');

            const duplicate = createTestAuthDeps();
            await signedUp(duplicate);
            expect((await verifyRecovery(duplicate, await recoveryToken(duplicate))).kind).toBe('conflict');
        });
    });

    it('sends no mail and logs the rule when the limiter cannot decide', async () => {
        const deps = createTestAuthDeps({ rateLimiter: { consume: () => Promise.resolve('unavailable') } });
        await createSignupFlow(deps).start({ email, locale: 'cs' })();
        expect(deps.email.sent).toEqual([]);
        expect(deps.logger.entries).toEqual([
            { level: 'error', event: 'rate-limit.unavailable', fields: { rule: 'signup-start-email' } },
        ]);
    });

    it('logs a failed delivery by error name only', async () => {
        const deps = createTestAuthDeps();
        const failing = { ...deps, email: { send: () => Promise.reject(new TypeError('smtp: person@example.test')) } };
        await createSignupFlow(failing).start({ email, locale: 'en' })();
        await createSignupFlow({
            ...deps,
            email: { send: () => Promise.reject(Object.create(null) as Error) },
        }).start({
            email: emailAddressSchema.parse('b@example.test'),
            locale: 'en',
        })();
        expect(deps.logger.entries).toEqual([
            { level: 'error', event: 'auth.background-failed', fields: { flow: 'signup', error: 'TypeError' } },
            { level: 'error', event: 'auth.background-failed', fields: { flow: 'signup', error: 'unknown' } },
        ]);
    });
});
