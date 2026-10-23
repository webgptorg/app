import type { FakeEmailSender } from '../adapters/email/fake-email-sender';
import type { AuthLinks } from '../domain/auth/auth-deps';
import type { AuthStore } from '../domain/auth/auth-store';
import type { BillingService } from '../domain/billing/billing-service';
import type { Entitlements } from '../domain/billing/entitlements';
import type { Authorizer } from '../domain/authz/authorizer';
import type { DashboardAction } from '../domain/authz/policy';
import type { CustomHostnameStore } from '../domain/custom-hostnames/custom-hostname-store';
import type { PlatformEngineStore } from '../domain/engines/platform-engine-store';
import type { EngineStore } from '../domain/registration/engine-store';
import type { LinkCodeStore } from '../domain/registration/link-code-store';
import type { EngineHostnameStore } from '../domain/registry/engine-hostname-store';
import type { RegistryReader } from '../domain/registry/registry-reader';
import type { RelayTokenStore } from '../domain/registry/relay-token-store';
import type { EngineStatusDirectory } from '../domain/status/engine-status-directory';
import type { HeartbeatEngineReader } from '../domain/status/heartbeat-engine-reader';
import type { Clock } from '../domain/ports/clock';
import type { DnsResolver } from '../domain/ports/dns-resolver';
import type { EmailSender } from '../domain/ports/email-sender';
import type { Logger } from '../domain/ports/logger';
import type { Random } from '../domain/ports/random';
import type { RateLimiter } from '../domain/ports/rate-limiter';
import type { RelyingParty } from '../domain/ports/relying-party';
import type { Timer } from '../domain/ports/timer';
import type { DashboardMetrics } from '../domain/monitoring/dashboard-metrics';
import type { DashboardConfig } from './config';

/** Everything handlers may use. Later tasks add their ports here, built from the adapters `config.adapters` selects. */
export interface DashboardDeps {
    readonly config: DashboardConfig;
    readonly clock: Clock;
    readonly random: Random;
    /** Deadlines, such as the engine list's per-engine status timeout. */
    readonly timer: Timer;
    readonly logger: Logger;
    /** Aggregate counters (I-04): Analytics Engine, or memory in dev. */
    readonly metrics: DashboardMetrics;
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
    /** Platform admins' unscoped read and suspension of any engine (I-05). */
    readonly platformEngines: PlatformEngineStore;
    readonly relayTokens: RelayTokenStore;
    /** Relays' unscoped read of engines (D-04). */
    readonly registry: RegistryReader;
    /** Active custom hostnames with their claims, for the registry and the engine pages. */
    readonly engineHostnames: EngineHostnameStore;
    /** The platform admin's side of the same table (D-08). */
    readonly customHostnames: CustomHostnameStore;
    /** Where admins' DNS checks of custom hostnames go. */
    readonly dns: DnsResolver;
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
