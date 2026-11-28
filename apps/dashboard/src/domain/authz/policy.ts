import type { PolicyTable } from './authorizer';

const PLAIN = { sensitive: false, requiresStepUp: false } as const;
const SENSITIVE = { sensitive: true, requiresStepUp: false } as const;
const STEP_UP = { sensitive: false, requiresStepUp: true } as const;
const SENSITIVE_STEP_UP = { sensitive: true, requiresStepUp: true } as const;

const EVERYONE = ['owner', 'admin', 'member'] as const;
const MANAGERS = ['owner', 'admin'] as const;

/** Every task that adds an endpoint adds its action here; handlers never compare role names. */
export const DASHBOARD_POLICY = {
    'org.read': { scope: 'org', orgRoles: EVERYONE, ...PLAIN },
    'account.read': { scope: 'self', ...PLAIN },
    'passkey.manage': { scope: 'self', ...PLAIN },
    'session.manage': { scope: 'self', ...PLAIN },
    'billing.read': { scope: 'org', orgRoles: ['owner'], ...PLAIN },
    'billing.manage': { scope: 'org', orgRoles: ['owner'], ...PLAIN },
    // Issue a link code that ties a new engine to the organization (D-03); entitlements gate it separately.
    'engine.link': { scope: 'org', orgRoles: MANAGERS, ...PLAIN },
    // The organization's engines with their registry data and heartbeat numbers (D-06); members see their teams' only.
    'engine.read': { scope: 'org', orgRoles: EVERYONE, ...PLAIN },
    // The owner's own name for an engine (D-06): account metadata, audited, never sent to the engine.
    'engine.rename': { scope: 'org', orgRoles: MANAGERS, ...PLAIN },
    // Permanent: relays stop routing the engine ID, and recovery is a new engine identity (D-06).
    'engine.revoke': { scope: 'org', orgRoles: MANAGERS, ...SENSITIVE_STEP_UP },
    // Teams (ADR 0018). Members see and leave their own teams; the handlers narrow `team.read` to them.
    'team.read': { scope: 'org', orgRoles: EVERYONE, ...PLAIN },
    'team.leave': { scope: 'org', orgRoles: EVERYONE, ...PLAIN },
    'team.manage': { scope: 'org', orgRoles: MANAGERS, ...PLAIN },
    // Revokes the team's engine, like `engine.revoke`.
    'team.delete': { scope: 'org', orgRoles: MANAGERS, ...SENSITIVE_STEP_UP },
    // Adding and removing people: a hijacked account must not hand out or take away access during the cooldown.
    'team.members.manage': { scope: 'org', orgRoles: MANAGERS, ...SENSITIVE },
    'org.members.read': { scope: 'org', orgRoles: MANAGERS, ...PLAIN },
    'org.members.manage': { scope: 'org', orgRoles: MANAGERS, ...SENSITIVE },
    'org.roles.manage': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
    'org.leave': { scope: 'org', orgRoles: EVERYONE, ...PLAIN },
    // Joining another organization from an emailed invitation: the invitation is checked, not the active organization.
    'invite.accept': { scope: 'self', ...PLAIN },
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
    // No routes yet; listed now so the recovery cooldown covers them from day one.
    'engine.remove': { scope: 'org', orgRoles: MANAGERS, ...SENSITIVE },
    'engine.hostnames.manage': { scope: 'org', orgRoles: MANAGERS, ...SENSITIVE },
    'billing.owner.change': { scope: 'org', orgRoles: ['owner'], ...SENSITIVE },
    // Website licences (D-30, ADR 0021): advisory coverage, so whoever links engines may see it.
    'license.read': { scope: 'org', orgRoles: MANAGERS, ...PLAIN },
    // Binds the organization to a website account; a hijacked account must not rebind it during the cooldown.
    'license.link': { scope: 'org', orgRoles: MANAGERS, ...SENSITIVE },
    // What the organization's meters count now and per day, with its limits (ADR 0025): counts only.
    'usage.read': { scope: 'org', orgRoles: MANAGERS, ...PLAIN },
} as const satisfies PolicyTable<string>;

export type DashboardAction = keyof typeof DASHBOARD_POLICY;
