export interface DashboardLinks {
    readonly allEngines: string | null;
    readonly addEngine: string | null;
}

/** The dashboard's engine list and its "add engine" page, or none when the engine is not linked to a dashboard. */
export function dashboardLinks(dashboardUrl: string | null): DashboardLinks {
    if (dashboardUrl === null) return { allEngines: null, addEngine: null };
    const base = new URL(dashboardUrl);
    return {
        allEngines: base.href,
        addEngine: new URL(`${base.pathname.replace(/\/$/, '')}/engines/new`, base).href,
    };
}
