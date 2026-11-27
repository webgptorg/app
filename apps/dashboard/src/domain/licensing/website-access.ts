import { newSecret, sha256Hex } from '../auth/secrets';
import { newOrgAuditEntryId, type OrgId, type UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Random } from '../ports/random';
import {
    linkWebsiteIdentity,
    type LinkOutcome,
    type WebsiteIdentity,
    type WebsiteIdentityLinkStore,
} from './website-handoff';

const MINUTE_MS = 60_000;
/** The website may first have to sign its member in; its own ticket then lives 60 seconds. */
export const HANDOFF_STATE_TTL_MS = 10 * MINUTE_MS;
/** Long enough for the App's own confirmation email (15 minutes) and a passkey ceremony after it. */
export const PENDING_LINK_TTL_MS = 30 * MINUTE_MS;

/** The website's verified identity, held for this browser until an App account signs in or is created. */
export interface PendingLinkRecord {
    /** SHA-256 of the cookie value; the value itself is never stored. */
    readonly tokenHash: string;
    readonly subject: string;
    readonly email: string;
    readonly createdAt: number;
    readonly expiresAt: number;
}

export interface WebsiteHandoffStore {
    /** Also drops expired states, so the table only holds live handoffs. */
    createState(state: {
        readonly challengeHash: string;
        readonly createdAt: number;
        readonly expiresAt: number;
    }): Promise<void>;
    /** Deletes the state in one statement and says whether it was there and unexpired, so it works at most once. */
    consumeState(challengeHash: string, now: number): Promise<boolean>;
    /** Also drops expired pending links. */
    createPending(pending: PendingLinkRecord): Promise<void>;
    findPending(tokenHash: string, now: number): Promise<PendingLinkRecord | null>;
    deletePending(tokenHash: string): Promise<void>;
}

/** The server-to-server ticket exchange; null for every failure, which the caller cannot tell apart anyway. */
export interface WebsiteIdentityExchange {
    exchange(
        input: { readonly code: string; readonly challenge: string },
        signal: AbortSignal,
    ): Promise<WebsiteIdentity | null>;
}

export interface WebsiteAccessDeps {
    readonly clock: Clock;
    readonly random: Random;
    readonly handoffs: WebsiteHandoffStore;
    readonly websiteLinks: WebsiteIdentityLinkStore;
    readonly exchange: WebsiteIdentityExchange;
    readonly accounts: { findUserByEmail(email: string): Promise<unknown> };
}

export type CompleteOutcome =
    | { readonly kind: 'pending'; readonly token: string; readonly expiresAt: number }
    | { readonly kind: 'state-invalid' | 'exchange-failed' };

export type PendingView =
    | { readonly kind: 'pending'; readonly email: string; readonly accountExists: boolean; readonly expiresAt: number }
    | { readonly kind: 'none' };

/**
 * ADR 0021's handoff. The website proves a mailbox and a subject, nothing more: an App account is still created through
 * the App's own email link and passkey, and only a signed-in owner or admin of that same address links it.
 */
export function createWebsiteAccessFlows(deps: WebsiteAccessDeps) {
    async function findPending(token: string | null): Promise<PendingLinkRecord | null> {
        return token === null ? null : deps.handoffs.findPending(await sha256Hex(token), deps.clock.nowMs());
    }

    return {
        /** The challenge goes to the website in the URL and into this browser's cookie; only its hash is stored. */
        async start(): Promise<{ readonly challenge: string; readonly expiresAt: number }> {
            const challenge = newSecret(deps.random);
            const now = deps.clock.nowMs();
            const expiresAt = now + HANDOFF_STATE_TTL_MS;
            await deps.handoffs.createState({ challengeHash: await sha256Hex(challenge), createdAt: now, expiresAt });
            return { challenge, expiresAt };
        },

        /** Consumes the state before the exchange, so a replayed, expired or foreign callback never reaches the website. */
        async complete(
            input: { readonly code: string; readonly challenge: string | null },
            signal: AbortSignal,
        ): Promise<CompleteOutcome> {
            if (
                input.challenge === null ||
                !(await deps.handoffs.consumeState(await sha256Hex(input.challenge), deps.clock.nowMs()))
            ) {
                return { kind: 'state-invalid' };
            }
            const identity = await deps.exchange.exchange({ code: input.code, challenge: input.challenge }, signal);
            if (identity === null) {
                return { kind: 'exchange-failed' };
            }
            const token = newSecret(deps.random);
            const now = deps.clock.nowMs();
            const expiresAt = now + PENDING_LINK_TTL_MS;
            await deps.handoffs.createPending({
                tokenHash: await sha256Hex(token),
                subject: identity.subject,
                email: identity.email.trim().toLowerCase(),
                createdAt: now,
                expiresAt,
            });
            return { kind: 'pending', token, expiresAt };
        },

        /** The website came back without a ticket; the state is spent all the same, like after a failed exchange. */
        async abandon(challenge: string | null): Promise<void> {
            if (challenge !== null) {
                await deps.handoffs.consumeState(await sha256Hex(challenge), deps.clock.nowMs());
            }
        },

        /**
         * Whether the address has an App account decides between sign-in and sign-up. Only a browser holding the pending
         * cookie learns it, about the address the website just verified for that same browser.
         */
        async pending(token: string | null): Promise<PendingView> {
            const pending = await findPending(token);
            if (pending === null) {
                return { kind: 'none' };
            }
            return {
                kind: 'pending',
                email: pending.email,
                accountExists: (await deps.accounts.findUserByEmail(pending.email)) !== null,
                expiresAt: pending.expiresAt,
            };
        },

        /** The pending link survives a mismatch, so signing out and in with the right passkey can still finish it. */
        async link(input: {
            readonly token: string | null;
            readonly actor: { readonly userId: UserId; readonly email: string; readonly orgId: OrgId };
        }): Promise<LinkOutcome | 'pending-invalid'> {
            const pending = await findPending(input.token);
            if (pending === null) {
                return 'pending-invalid';
            }
            const outcome = await linkWebsiteIdentity({
                actorId: input.actor.userId,
                actorEmail: input.actor.email,
                orgId: input.actor.orgId,
                identity: { subject: pending.subject, email: pending.email, emailVerified: true },
                auditId: newOrgAuditEntryId(deps.random),
                at: deps.clock.nowMs(),
                store: deps.websiteLinks,
            });
            if (outcome === 'linked') {
                await deps.handoffs.deletePending(pending.tokenHash);
            }
            return outcome;
        },
    };
}

export type WebsiteAccessFlows = ReturnType<typeof createWebsiteAccessFlows>;
