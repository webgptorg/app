import type { Hono } from 'hono';

import type { Entitlements } from '../../domain/billing/entitlements';
import type { MeteringStore } from '../../domain/metering/metering-store';
import { readUsageOverview } from '../../domain/metering/usage-overview';
import type { Clock } from '../../domain/ports/clock';
import { utcDay } from '../../domain/usage/usage-day';
import { apiRoutes } from '../../shared/api/routes';
import { USAGE_HISTORY_DAYS } from '../../shared/api/usage';
import type { RouteBinder } from './bind-route';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ADR 0025's read-only usage view, for the session's active organization only. */
export function bindUsageRoutes(
    router: Hono,
    mount: string,
    deps: {
        readonly entitlements: Entitlements;
        readonly metering: MeteringStore;
        readonly clock: Clock;
        readonly routes: RouteBinder;
    },
): void {
    deps.routes.bind(router, mount, apiRoutes.getUsage, async ({ session, request }) => {
        const { orgId } = session.actor;
        const from = utcDay(deps.clock.nowMs() - (USAGE_HISTORY_DAYS - 1) * DAY_MS);
        const [overview, days] = await Promise.all([
            readUsageOverview({ entitlements: deps.entitlements, store: deps.metering }, orgId, request.signal),
            deps.metering.listMeterDays(orgId, from),
        ]);
        return {
            kind: 'ok',
            body: {
                overLimit: overview.overLimit,
                meters: overview.meters.map(({ meter, limits, reading }) => ({
                    meter,
                    limits,
                    org: reading.org,
                    teams: [...reading.teams],
                    projects: [...reading.projects],
                })),
                history: days
                    .filter((day) => day.scope === 'org')
                    .map(({ day, meter, value, unreported, peak }) => ({ day, meter, value, unreported, peak })),
            },
        };
    });
}
