import type { ClientInfo, Member, Passkey, Permission, Session } from '@ptbk/engine-api';
import { MemberId, SessionId, Timestamp } from '@ptbk/engine-api';
import type { Actor } from '@ptbk/engine-api/in-memory';
import { encodeBase64Url } from '@ptbk/protocol';

import { permissionsFor } from '../authorization/policy';
import type { Clock } from '../clock';
import type { Random } from '../random';

export const SESSION_COOKIE_NAME = '__Host-ptbk_session';
/** A session nobody used for this long is over. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
/** However active, a session ends this long after sign-in. */
export const SESSION_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60_000;
/** How long a passkey assertion (sign-in, or the step-up form) counts as fresh for `stepUp` routes. */
export const STEP_UP_WINDOW_MS = 5 * 60_000;
const ID_BYTES = 16;

/** The engine's session list, which is the only one: a session it no longer lists is signed out. */
export interface SessionEngine {
    addSession(session: {
        readonly id: string;
        readonly memberId: string;
        readonly client: ClientInfo | null;
        readonly createdAt: string;
        readonly lastSeenAt: string;
        readonly expiresAt: string;
        readonly passkeyId: string | null;
    }): Session;
    removeSession(sessionId: string): boolean;
    inspect(): {
        readonly members: readonly Member[];
        readonly passkeys: readonly Passkey[];
        readonly sessions: readonly Session[];
    };
}

export interface SignInRequest {
    readonly memberId: string;
    /** An explicit permission set (`/__mock/sessions`); `null` takes the member's role from the policy. */
    readonly permissions: readonly Permission[] | null;
    readonly client: ClientInfo;
    /**
     * Resumes a session the engine already lists for this member instead of creating one; it still gets a new cookie
     * token. Only tests that seed sessions use it.
     */
    readonly sessionId?: string;
    /** A sign-in is a passkey assertion, so it is fresh unless told otherwise. */
    readonly stepUp?: 'fresh' | 'none';
    /** The passkey the gateway verified; without one (dev login, control sessions) the member's newest stands in. */
    readonly passkeyId?: string;
}

export interface SignedIn {
    /** The cookie value: the only secret, never shown by the API (session IDs are listed to admins). */
    readonly token: string;
    readonly sessionId: SessionId;
    readonly memberId: MemberId;
}

export type Authentication = { readonly kind: 'signed-in'; readonly actor: Actor } | { readonly kind: 'invalid' };

export interface SessionStore {
    /** Throws for a member the engine does not list as active. */
    signIn(request: SignInRequest): SignedIn;
    /** Resolves a cookie token to the engine's actor, reading the member's current role and the engine's session list. */
    authenticate(token: string, client: ClientInfo): Authentication;
    /** The dev step-up form: the session counts as freshly asserted for {@link STEP_UP_WINDOW_MS}. */
    confirmStepUp(sessionId: string): boolean;
    /** Every session's assertion goes stale at once, as the window would; tests use it to reach step-up on demand. */
    expireStepUps(): void;
    signOut(sessionId: string): void;
    /** Forgets every token, e.g. when the engine state is replaced. */
    clear(): void;
}

interface GatewaySession {
    readonly token: string;
    readonly sessionId: SessionId;
    readonly memberId: MemberId;
    readonly permissions: readonly Permission[] | null;
    readonly createdMs: number;
    lastSeenMs: number;
    stepUpMs: number | null;
}

/**
 * A stand-in for the engine gateway's session rules, not a port of it. Tokens and session IDs are 128-bit values from
 * the crypto `Random`; every sign-in gets new ones. The member's role and the engine's session list are read on every
 * request, so a role change, a revoked session or a removed member applies at once.
 */
export function createSessionStore(deps: {
    readonly engine: () => SessionEngine;
    readonly clock: Clock;
    readonly random: Random;
}): SessionStore {
    const byToken = new Map<string, GatewaySession>();
    const newId = (): string => encodeBase64Url(deps.random.bytes(ID_BYTES));
    const timestamp = (ms: number): string => Timestamp.parse(new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));

    function end(session: GatewaySession): void {
        byToken.delete(session.token);
        deps.engine().removeSession(session.sessionId);
    }

    return {
        signIn(request) {
            const engine = deps.engine();
            const snapshot = engine.inspect();
            const member = snapshot.members.find(({ id }) => id === request.memberId);
            if (member?.status !== 'active') throw new Error('sign-in for a member who is not active');
            const nowMs = deps.clock.nowMs();
            const existing =
                request.sessionId === undefined
                    ? undefined
                    : snapshot.sessions.find(({ id, memberId }) => id === request.sessionId && memberId === member.id);
            const sessionId = SessionId.parse(existing?.id ?? newId());
            if (existing === undefined) {
                // Without a ceremony (dev login, control sessions) it signs in as if with the member's newest passkey.
                const passkey = snapshot.passkeys
                    .filter(({ memberId }) => memberId === member.id)
                    .reduce<Passkey | null>(
                        (newest, candidate) =>
                            newest === null || candidate.createdAt > newest.createdAt ? candidate : newest,
                        null,
                    );
                engine.addSession({
                    id: sessionId,
                    memberId: member.id,
                    passkeyId: request.passkeyId ?? passkey?.id ?? null,
                    client: request.client,
                    createdAt: timestamp(nowMs),
                    lastSeenAt: timestamp(nowMs),
                    expiresAt: timestamp(nowMs + SESSION_ABSOLUTE_TIMEOUT_MS),
                });
            }
            const session: GatewaySession = {
                token: newId(),
                sessionId,
                memberId: MemberId.parse(member.id),
                permissions: request.permissions === null ? null : [...new Set(request.permissions)],
                createdMs: nowMs,
                lastSeenMs: nowMs,
                stepUpMs: request.stepUp === 'none' ? null : nowMs,
            };
            byToken.set(session.token, session);
            return { token: session.token, sessionId: session.sessionId, memberId: session.memberId };
        },
        authenticate(token, client) {
            const session = byToken.get(token);
            if (session === undefined) return { kind: 'invalid' };
            const nowMs = deps.clock.nowMs();
            if (
                nowMs - session.lastSeenMs > SESSION_IDLE_TIMEOUT_MS ||
                nowMs - session.createdMs > SESSION_ABSOLUTE_TIMEOUT_MS
            ) {
                end(session);
                return { kind: 'invalid' };
            }
            const snapshot = deps.engine().inspect();
            const member = snapshot.members.find(({ id }) => id === session.memberId);
            if (!snapshot.sessions.some(({ id }) => id === session.sessionId) || member?.status !== 'active') {
                end(session);
                return { kind: 'invalid' };
            }
            session.lastSeenMs = nowMs;
            return {
                kind: 'signed-in',
                actor: {
                    memberId: session.memberId,
                    sessionId: session.sessionId,
                    client,
                    permissions: permissionsFor(member, session),
                    stepUpFresh: session.stepUpMs !== null && nowMs - session.stepUpMs <= STEP_UP_WINDOW_MS,
                },
            };
        },
        confirmStepUp(sessionId) {
            for (const session of byToken.values()) {
                if (session.sessionId !== sessionId) continue;
                session.stepUpMs = deps.clock.nowMs();
                return true;
            }
            return false;
        },
        expireStepUps() {
            for (const session of byToken.values()) session.stepUpMs = null;
        },
        signOut(sessionId) {
            for (const session of [...byToken.values()]) if (session.sessionId === sessionId) end(session);
            deps.engine().removeSession(sessionId);
        },
        clear() {
            byToken.clear();
        },
    };
}
