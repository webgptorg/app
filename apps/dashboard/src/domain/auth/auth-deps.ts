import type { Clock } from '../ports/clock';
import type { EmailSender } from '../ports/email-sender';
import type { Logger } from '../ports/logger';
import type { Random } from '../ports/random';
import type { RateLimiter } from '../ports/rate-limiter';
import type { RelyingParty } from '../ports/relying-party';
import type { AuthStore } from './auth-store';

/** Absolute URLs on the dashboard origin that emails link to; tokens travel in the fragment, never in a query. */
export interface AuthLinks {
    signup(token: string): string;
    recovery(token: string): string;
    signIn(): string;
    recover(): string;
    /** The invitation page (ADR 0018); the token rides in the fragment, so it never reaches a log or a `Referer`. */
    invite(token: string): string;
}

export interface AuthDeps {
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
    readonly store: AuthStore;
    readonly relyingParty: RelyingParty;
    readonly email: EmailSender;
    readonly rateLimiter: RateLimiter;
    readonly links: AuthLinks;
}
