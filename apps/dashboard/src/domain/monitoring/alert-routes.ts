import type { AlertRule } from './alert-rules';

/** Where an alert is delivered: the ops address (`MONITORING.opsEmail`) or the abuse inbox (`ABUSE_EMAIL`). */
export type AlertRoute = 'ops' | 'abuse';

const ROUTES = {
    'relay-unreachable': 'ops',
    'relay-tunnels-dropped': 'ops',
    'relay-registry-errors': 'ops',
    'relay-certificate-expiring': 'ops',
    'dashboard-unhealthy': 'ops',
    'heartbeat-rejections': 'ops',
    'email-failures': 'ops',
    // A failing abuse job is an ops problem too: the job itself is broken, not an engine.
    'cron-job-failing': 'ops',
    'ct-wildcard': 'abuse',
    'ct-foreign-issuer': 'abuse',
    'ct-unknown-hostname': 'abuse',
    'ct-issuance-spike': 'abuse',
    'public-face-mismatch': 'abuse',
    'abuse-feed-listed': 'abuse',
} as const satisfies Readonly<Record<AlertRule, AlertRoute>>;

/** A rule name as an email carries it; anything unknown goes to ops. */
export function alertRoute(rule: string): AlertRoute {
    return Object.hasOwn(ROUTES, rule) ? ROUTES[rule as AlertRule] : 'ops';
}

/** The runbook an alert links to. */
export const ALERT_RUNBOOKS = {
    ops: 'docs/runbooks/observability.md',
    abuse: 'docs/runbooks/abuse-takedown.md',
} as const satisfies Readonly<Record<AlertRoute, string>>;
