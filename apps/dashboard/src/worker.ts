import { createDevAdapters } from './app/dev-adapters';
import { createDashboard } from './app/create-dashboard';

export { HourlyRateLimiter } from './adapters/rate-limit/hourly-rate-limiter-object';

// Lives as long as the isolate, so the fake outbox and in-memory limits outlast a request. They are only wired when
// the config selects the fake and memory adapters, which it allows in dev alone.
const devAdapters = createDevAdapters();

export default {
    fetch(request, env, ctx) {
        return createDashboard(env, { viteDevServer: import.meta.env.DEV, devAdapters }).fetch(request, env, ctx);
    },
} satisfies ExportedHandler<Env>;
