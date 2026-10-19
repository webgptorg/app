import type { PolicyTable } from './authorizer';

/** Every task that adds an endpoint adds its action here; handlers never compare role names. */
export const DASHBOARD_POLICY = {
    'org.read': { orgRoles: ['owner'], platformAdminOnly: false, sensitive: false },
} as const satisfies PolicyTable<string>;

export type DashboardAction = keyof typeof DASHBOARD_POLICY;
