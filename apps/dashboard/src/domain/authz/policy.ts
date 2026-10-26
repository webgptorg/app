import type { PolicyTable } from './authorizer';

const PLAIN = { sensitive: false, requiresStepUp: false } as const;
const SENSITIVE = { sensitive: true, requiresStepUp: false } as const;
const STEP_UP = { sensitive: false, requiresStepUp: true } as const;
const SENSITIVE_STEP_UP = { sensitive: true, requiresStepUp: true } as const;

/** Every task that adds an endpoint adds its action here; handlers never compare role names. */
export const DASHBOARD_POLICY = {
    'org.read': { scope: 'org', orgRoles: ['owner'], ...PLAIN },
    'account.read': { scope: 'self', ...PLAIN },
    'passkey.manage': { scope: 'self', ...PLAIN },
    'session.manage': { scope: 'self', ...PLAIN },
    'billing.read': { scope: 'org', orgRoles: ['owner'], ...PLAIN },
    'billing.manage': { scope: 'org', orgRoles: ['owner'], ...PLAIN },
    // Issue a link code that ties a new engine to the organization (D-03); entitlements gate it separately.
    'engine.link': { scope: 'org', orgRoles: ['owner'], ...PLAIN },
    // The organization's engines with their registry data and heartbeat numbers (D-06).
    'engine.read': { scope: 'org', orgRoles: ['owner'], ...PLAIN },
    // Permanent: relays stop routing the engine ID, and recovery is a new engine identity (D-06).
    'engine.revoke': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE_STEP_UP },
    // Read-only list of organizations in a problem state; acting on one (suspension, I-05) needs its own step-up action.
    'admin.billing.read': { scope: 'platform', ...PLAIN },
    // Any organization's engine with its status, for abuse handling (I-05).
    'admin.engine.read': { scope: 'platform', ...PLAIN },
    // Suspend and unsuspend an engine for abuse or non-payment (I-05); audited, with the admin's reason.
    'admin.engine.suspend': { scope: 'platform', ...STEP_UP },
    // An engine's custom hostnames and the CNAME target to hand the customer (D-08).
    'admin.hostnames.read': { scope: 'platform', ...PLAIN },
    // Attach, DNS-check and remove an Enterprise customer's hostname (D-08); every change is audited.
    'admin.hostnames.manage': { scope: 'platform', ...STEP_UP },
    // No routes yet (later tasks build them; v0 orgs have one owner); listed now so the recovery cooldown covers them from day one.
    'engine.remove': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
    'engine.hostnames.manage': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
    'billing.owner.change': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
} as const satisfies PolicyTable<string>;

export type DashboardAction = keyof typeof DASHBOARD_POLICY;
