import { createDashboard } from './app/create-dashboard';

export default {
    fetch(request, env, ctx) {
        return createDashboard(env, { viteDevServer: import.meta.env.DEV }).fetch(request, env, ctx);
    },
} satisfies ExportedHandler<Env>;
