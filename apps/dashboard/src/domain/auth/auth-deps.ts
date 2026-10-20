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
