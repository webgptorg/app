import type { FakeEmailSender } from '../adapters/email/fake-email-sender';
import type { AuthLinks } from '../domain/auth/auth-deps';
import type { AuthStore } from '../domain/auth/auth-store';
import type { BillingService } from '../domain/billing/billing-service';
import type { Entitlements } from '../domain/billing/entitlements';
import type { Authorizer } from '../domain/authz/authorizer';
import type { DashboardAction } from '../domain/authz/policy';
import type { EngineStore } from '../domain/registration/engine-store';
import type { LinkCodeStore } from '../domain/registration/link-code-store';
import type { EngineHostnameStore } from '../domain/registry/engine-hostname-store';
import type { RegistryReader } from '../domain/registry/registry-reader';
import type { RelayTokenStore } from '../domain/registry/relay-token-store';
import type { EngineStatusDirectory } from '../domain/status/engine-status-directory';
import type { HeartbeatEngineReader } from '../domain/status/heartbeat-engine-reader';
import type { Clock } from '../domain/ports/clock';
import type { EmailSender } from '../domain/ports/email-sender';
import type { Logger } from '../domain/ports/logger';
import type { Random } from '../domain/ports/random';
import type { RateLimiter } from '../domain/ports/rate-limiter';
import type { RelyingParty } from '../domain/ports/relying-party';
import type { DashboardConfig } from './config';

/** Everything handlers may use. Later tasks add their ports here, built from the adapters `config.adapters` selects. */
export interface DashboardDeps {
    readonly config: DashboardConfig;
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
    readonly authorizer: Authorizer<DashboardAction>;
    readonly store: AuthStore;
    readonly relyingParty: RelyingParty;
    readonly email: EmailSender;
    readonly rateLimiter: RateLimiter;
    readonly links: AuthLinks;
    readonly billing: BillingService;
    /** What every gated action asks (ADR 0017); nothing outside billing sees plans or the provider. */
    readonly entitlements: Entitlements;
    readonly linkCodes: LinkCodeStore;
    readonly engines: EngineStore;
    readonly relayTokens: RelayTokenStore;
    /** Relays' unscoped read of engines (D-04). */
    readonly registry: RegistryReader;
    readonly engineHostnames: EngineHostnameStore;
    /** Heartbeats' unscoped read of `engines` (D-05). */
    readonly heartbeatEngines: HeartbeatEngineReader;
    /** One status object per engine: heartbeats, offline detection, alerts. */
    readonly engineStatus: EngineStatusDirectory;
    /** The fake outbox behind `email` when `config.adapters.email` is `fake` (dev only), else null. */
    readonly devOutbox: FakeEmailSender | null;
}

export function authLinks(dashboardOrigin: string): AuthLinks {
    return {
        signup: (token) => `${dashboardOrigin}/signup#${token}`,
        recovery: (token) => `${dashboardOrigin}/recover#${token}`,
        signIn: () => `${dashboardOrigin}/signin`,
        recover: () => `${dashboardOrigin}/recover`,
    };
}
