export interface DashboardLinks {
    readonly allEngines: string | null;
    readonly addEngine: string | null;
    readonly trust: string | null;
}

/**
 * The dashboard's engine list, its "add engine" page and "How Promptbook protects you", or none when the engine is not
 * linked to a dashboard.
 */
export function dashboardLinks(dashboardUrl: string | null): DashboardLinks {
    if (dashboardUrl === null) return { allEngines: null, addEngine: null, trust: null };
    const base = new URL(dashboardUrl);
    const page = (path: string) => new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base).href;
    return { allEngines: base.href, addEngine: page('/engines/new'), trust: page('/trust') };
}
