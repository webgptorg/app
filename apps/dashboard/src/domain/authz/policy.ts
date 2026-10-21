import type { PolicyTable } from './authorizer';

const PLAIN = { sensitive: false, requiresStepUp: false } as const;
const SENSITIVE = { sensitive: true, requiresStepUp: false } as const;

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
    // Read-only list of organizations in a problem state; acting on one (suspension, I-05) needs its own step-up action.
    'admin.billing.read': { scope: 'platform', ...PLAIN },
    // No routes yet (D-06, D-08 build them; v0 orgs have one owner); listed now so the recovery cooldown covers them from day one.
    'engine.remove': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
    'engine.hostnames.manage': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
    'billing.owner.change': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
} as const satisfies PolicyTable<string>;

export type DashboardAction = keyof typeof DASHBOARD_POLICY;
