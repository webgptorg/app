import { OpsMonitorObject } from './adapters/monitoring/ops-monitor-object';
import { EngineStatusObject } from './adapters/status/engine-status-object';
import { createDevAdapters } from './app/dev-adapters';
import { createDashboard } from './app/create-dashboard';
import { createEngineStatus } from './app/engine-status';
import { createOpsMonitor } from './app/ops-monitor';
import { runScheduled } from './app/scheduled';

export { HourlyRateLimiter } from './adapters/rate-limit/hourly-rate-limiter-object';

// Lives as long as the isolate, so the fake outbox and in-memory limits outlast a request. They are only wired when
// the config selects the fake and memory adapters, which it allows in dev alone.
const devAdapters = createDevAdapters();

/** One per engine, named by its engine ID (D-05). In dev it shares the isolate's fake outbox with the Worker. */
export class EngineStatus extends EngineStatusObject {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env, (storage) => createEngineStatus(env, storage, devAdapters));
    }
}

/** The one alert-state object (I-04), named `ops`. */
export class OpsMonitor extends OpsMonitorObject {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env, (storage) => createOpsMonitor(env, storage));
    }
}

export default {
    fetch(request, env, ctx) {
        return createDashboard(env, { viteDevServer: import.meta.env.DEV, devAdapters }).fetch(request, env, ctx);
    },
    scheduled(controller, env, ctx) {
        return runScheduled(controller, env, ctx, devAdapters);
    },
} satisfies ExportedHandler<Env>;
