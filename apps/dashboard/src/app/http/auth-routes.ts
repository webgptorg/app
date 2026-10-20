import type { Hono } from 'hono';

import { createAccountFlows, type ActiveSession } from '../../domain/auth/account';
import type { AuthDeps } from '../../domain/auth/auth-deps';
import type { IssuedSession } from '../../domain/auth/ceremony';
import { emailAddressSchema } from '../../domain/auth/email-address';
import type { PasskeyRecord } from '../../domain/auth/records';
import { createRecoveryFlow } from '../../domain/auth/recovery';
import { createSignInFlow } from '../../domain/auth/signin';
import { createSignupFlow, type DeferredDelivery } from '../../domain/auth/signup';
import { CHALLENGE_TTL_MS } from '../../domain/auth/timing';
import { orgPermissions, RECOVERY_COOLDOWN_MS, STEP_UP_WINDOW_MS } from '../../domain/authz/authorizer';
import { DASHBOARD_POLICY } from '../../domain/authz/policy';
import { apiRoutes, type SessionView } from '../../shared/api/routes';
import { resolveRequestLocale } from '../i18n/resolve-request-locale';
import type { RequestContext, RouteBinder } from './bind-route';
import {
    CHALLENGE_COOKIE,
    challengeCookie,
    clearChallengeCookie,
    clearSessionCookie,
    SESSION_COOKIE,
    sessionCookie,
} from './cookies';

function requestLocale(request: RequestContext) {
    return resolveRequestLocale({
        userLocale: null,
        cookieHeader: request.header('cookie'),
        acceptLanguage: request.header('accept-language'),
    });
}

const CEREMONY_FAILURES = {
    'challenge-invalid': 400,
    'token-invalid': 400,
    'webauthn-failed': 401,
    conflict: 409,
} as const;

function failure<K extends keyof typeof CEREMONY_FAILURES>(kind: K) {
    // Every verify consumed its challenge, so the cookie that pointed at it goes too.
    return {
        kind: 'problem',
        status: CEREMONY_FAILURES[kind],
        code: kind,
        setCookies: [clearChallengeCookie()],
    } as const;
}

function withChallenge<O>(options: O, challengeId: string) {
    return { kind: 'ok', body: { options }, setCookies: [challengeCookie(challengeId, CHALLENGE_TTL_MS)] } as const;
}

function invalidEmail() {
    return { kind: 'problem', status: 400, code: 'invalid-request' } as const;
}

function passkeyView(passkey: PasskeyRecord) {
    return {
        credentialId: passkey.credentialId,
        addedVia: passkey.addedVia,
        createdAt: passkey.createdAt,
        lastUsedAt: passkey.lastUsedAt,
        backedUp: passkey.backedUp,
        counterRegressedAt: passkey.counterRegressedAt,
    };
}

/** Signup, sign-in, recovery, sessions and passkeys: D-02's `/api` routes. */
export function bindAuthRoutes(router: Hono, mount: string, deps: AuthDeps & { readonly routes: RouteBinder }): void {
    const signup = createSignupFlow(deps);
    const signIn = createSignInFlow(deps);
    const recovery = createRecoveryFlow(deps);
    const account = createAccountFlows(deps);
    const bind = deps.routes.bind.bind(deps.routes);

    async function sessionView(active: ActiveSession): Promise<SessionView> {
        const { user, membership, record } = active;
        const memberships = await account.listMemberships(user.id);
        return {
            user: {
                id: user.id,
                email: user.email,
                locale: user.locale,
                platformRole: user.platformRole,
                recoveredAt: user.recoveredAt,
                recoveryCooldownEndsAt: user.recoveredAt === null ? null : user.recoveredAt + RECOVERY_COOLDOWN_MS,
            },
            activeOrg: {
                id: membership.orgId,
                kind: membership.org.kind,
                name: membership.org.name,
                role: membership.role,
                permissions: [...orgPermissions(DASHBOARD_POLICY, membership.role)],
            },
            memberships: memberships.map((m) => ({ orgId: m.orgId, kind: m.org.kind, name: m.org.name, role: m.role })),
            steppedUpUntil: record.steppedUpAt === null ? null : record.steppedUpAt + STEP_UP_WINDOW_MS,
        };
    }

    async function signedIn(issued: IssuedSession) {
        const active = await account.resolveSession(issued.token);
        if (active === null) {
            throw new Error('a session created a moment ago does not resolve');
        }
        return {
            kind: 'ok',
            body: await sessionView(active),
            setCookies: [
                sessionCookie(issued.token, issued.record.expiresAt, deps.clock.nowMs()),
                clearChallengeCookie(),
            ],
        } as const;
    }

    function accepted(deliver: DeferredDelivery, request: RequestContext) {
        request.waitUntil(deliver());
        return { kind: 'ok', status: 202, body: { accepted: true } } as const;
    }

    // Signup

    bind(router, mount, apiRoutes.signupStart, ({ input, request }) => {
        const email = emailAddressSchema.safeParse(input.body.email);
        if (!email.success) {
            return Promise.resolve(invalidEmail());
        }
        return Promise.resolve(accepted(signup.start({ email: email.data, locale: requestLocale(request) }), request));
    });

    bind(router, mount, apiRoutes.signupOptions, async ({ input }) => {
        const outcome = await signup.options({ token: input.body.token });
        return outcome.kind === 'ok' ? withChallenge(outcome.options, outcome.challengeId) : failure(outcome.kind);
    });

    bind(router, mount, apiRoutes.signupVerify, async ({ input, request }) => {
        const outcome = await signup.verify({
            token: input.body.token,
            challengeId: request.secretCookie(CHALLENGE_COOKIE),
            response: input.body.response,
            locale: requestLocale(request),
        });
        return outcome.kind === 'ok' ? signedIn(outcome.session) : failure(outcome.kind);
    });

    // Sign-in

    bind(router, mount, apiRoutes.signinOptions, async () => {
        const { options, challengeId } = await signIn.options();
        return withChallenge(options, challengeId);
    });

    bind(router, mount, apiRoutes.signinVerify, async ({ input, request }) => {
        const outcome = await signIn.verify({
            challengeId: request.secretCookie(CHALLENGE_COOKIE),
            response: input.body.response,
            previousSessionToken: request.secretCookie(SESSION_COOKIE),
        });
        return outcome.kind === 'ok' ? signedIn(outcome.session) : failure(outcome.kind);
    });

    // Recovery

    bind(router, mount, apiRoutes.recoveryRequest, ({ input, request }) => {
        const email = emailAddressSchema.safeParse(input.body.email);
        if (!email.success) {
            return Promise.resolve(invalidEmail());
        }
        return Promise.resolve(accepted(recovery.request({ email: email.data }), request));
    });

    bind(router, mount, apiRoutes.recoveryOptions, async ({ input }) => {
        const outcome = await recovery.options({ token: input.body.token });
        return outcome.kind === 'ok' ? withChallenge(outcome.options, outcome.challengeId) : failure(outcome.kind);
    });

    bind(router, mount, apiRoutes.recoveryVerify, async ({ input, request }) => {
        const outcome = await recovery.verify({
            token: input.body.token,
            challengeId: request.secretCookie(CHALLENGE_COOKIE),
            response: input.body.response,
        });
        if (outcome.kind !== 'ok') {
            return failure(outcome.kind);
        }
        request.waitUntil(outcome.deliver());
        return signedIn(outcome.session);
    });

    // Session, step-up, sign-out

    bind(router, mount, apiRoutes.getSession, async ({ session }) => ({
        kind: 'ok',
        body: await sessionView(session),
    }));

    bind(router, mount, apiRoutes.stepUpOptions, async ({ session }) => {
        const { options, challengeId } = await account.stepUpOptions(session.user.id);
        return withChallenge(options, challengeId);
    });

    bind(router, mount, apiRoutes.stepUpVerify, async ({ input, request, session }) => {
        const outcome = await account.stepUp({
            session: session.record,
            challengeId: request.secretCookie(CHALLENGE_COOKIE),
            response: input.body.response,
        });
        if (outcome.kind !== 'ok') {
            return failure(outcome.kind);
        }
        return {
            kind: 'ok',
            body: { steppedUpUntil: outcome.steppedUpAt + STEP_UP_WINDOW_MS },
            setCookies: [clearChallengeCookie()],
        };
    });

    bind(router, mount, apiRoutes.signout, async ({ session }) => {
        await account.signOut(session.record);
        return { kind: 'ok', body: {}, setCookies: [clearSessionCookie()] };
    });

    // Sessions

    bind(router, mount, apiRoutes.listSessions, async ({ session }) => {
        const sessions = await account.listSessions(session.user.id);
        return {
            kind: 'ok',
            body: {
                sessions: sessions.map((listed) => ({
                    current: listed.idHash === session.record.idHash,
                    createdAt: listed.createdAt,
                    lastSeenAt: listed.lastSeenAt,
                    expiresAt: listed.expiresAt,
                })),
            },
        };
    });

    bind(router, mount, apiRoutes.revokeAllSessions, async ({ session }) => {
        await account.revokeAllSessions(session.user.id);
        return { kind: 'ok', body: {}, setCookies: [clearSessionCookie()] };
    });

    // Passkeys

    bind(router, mount, apiRoutes.listPasskeys, async ({ session }) => {
        const passkeys = await account.listPasskeys(session.user.id);
        return { kind: 'ok', body: { passkeys: passkeys.map(passkeyView) } };
    });

    bind(router, mount, apiRoutes.passkeyOptions, async ({ session }) => {
        const { options, challengeId } = await account.addPasskeyOptions(session.user);
        return withChallenge(options, challengeId);
    });

    bind(router, mount, apiRoutes.passkeyVerify, async ({ input, request, session }) => {
        const outcome = await account.addPasskey({
            userId: session.user.id,
            challengeId: request.secretCookie(CHALLENGE_COOKIE),
            response: input.body.response,
        });
        if (outcome.kind !== 'ok') {
            return failure(outcome.kind);
        }
        return { kind: 'ok', body: { passkey: passkeyView(outcome.passkey) }, setCookies: [clearChallengeCookie()] };
    });

    bind(router, mount, apiRoutes.passkeyDelete, async ({ input, session }) => {
        const outcome = await account.deletePasskey(session.user.id, input.body.credentialId);
        switch (outcome) {
            case 'deleted':
                return { kind: 'ok', body: {} };
            // Someone else's passkey does not exist for this user, so IDs cannot be probed.
            case 'not-found':
                return { kind: 'problem', status: 404, code: 'not-found' };
            case 'last':
                return { kind: 'problem', status: 409, code: 'last-passkey' };
        }
    });
}
