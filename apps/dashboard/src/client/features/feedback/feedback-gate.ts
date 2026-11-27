const UCHO_ORIGIN = 'https://clientcare.contember.com';
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The clientcare task URL for a ucho project ID, or null (no widget) when the build sets none or a malformed one. */
export function feedbackEndpoint(project: string | undefined): string | null {
    if (project === undefined || !PROJECT_ID.test(project)) {
        return null;
    }
    return `${UCHO_ORIGIN}/ucho/project/${project}/task`;
}

/** Browser automation (Playwright) never gets the widget: its full-page drawing overlay would swallow e2e clicks. */
export function underAutomation(nav: Pick<Navigator, 'webdriver'> | undefined): boolean {
    return nav?.webdriver === true;
}
