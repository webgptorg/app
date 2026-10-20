import type { PolicyTable } from './authorizer';

const PLAIN = { sensitive: false, requiresStepUp: false } as const;
const SENSITIVE = { sensitive: true, requiresStepUp: false } as const;

/** Every task that adds an endpoint adds its action here; handlers never compare role names. */
export const DASHBOARD_POLICY = {
    'org.read': { scope: 'org', orgRoles: ['owner'], ...PLAIN },
    'account.read': { scope: 'self', ...PLAIN },
    'passkey.manage': { scope: 'self', ...PLAIN },
    'session.manage': { scope: 'self', ...PLAIN },
    // No routes yet (D-03, D-07, D-08 build them); listed now so the recovery cooldown covers them from day one.
    'engine.remove': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
    'engine.hostnames.manage': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
    'billing.owner.change': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
} as const satisfies PolicyTable<string>;

export type DashboardAction = keyof typeof DASHBOARD_POLICY;
