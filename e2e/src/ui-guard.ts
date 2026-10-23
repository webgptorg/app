/*
 * What the UI flows (X-04) refuse on every page, whatever the test does: a CSP or Trusted Types violation, an uncaught
 * error, a request leaving the engine's origin, a native dialog. Pure helpers, so `bun run check` tests them without a
 * browser; ui-fixtures.ts wires them to the browser context.
 */

export interface GuardedViolation {
    readonly directive: string;
    readonly blockedUri: string;
    readonly sourceFile: string;
}

/** Everything the guard saw during one test; each list must be empty for the test to pass. */
export interface GuardReport {
    readonly cspViolations: readonly GuardedViolation[];
    readonly policyMessages: readonly string[];
    readonly pageErrors: readonly string[];
    readonly foreignRequests: readonly string[];
    readonly dialogs: readonly string[];
}

const POLICY_MESSAGE = /content.security.policy|trusted.?types?/i;

/** Console text in which Chromium or Firefox reports a CSP or Trusted Types refusal. */
export function isPolicyMessage(text: string): boolean {
    return POLICY_MESSAGE.test(text);
}

/**
 * Whether a request the browser made leaves the engine: anything but `https://<engineHost>` on the default port.
 * `data:` URLs (the editor's inline SVG backgrounds, which `img-src` allows) load nothing; `blob:` URLs carry the
 * origin that created them.
 */
export function isForeignRequest(url: string, engineHost: string): boolean {
    if (url.startsWith('data:')) return false;
    let parsed: URL;
    try {
        parsed = new URL(url.startsWith('blob:') ? url.slice('blob:'.length) : url);
    } catch {
        return true;
    }
    return parsed.protocol !== 'https:' || parsed.host !== engineHost;
}

export function emptyGuardReport(): GuardReport {
    return { cspViolations: [], policyMessages: [], pageErrors: [], foreignRequests: [], dialogs: [] };
}

/** One line per finding, for the failure message. */
export function guardFindings(report: GuardReport): readonly string[] {
    return [
        ...report.cspViolations.map(
            (violation) =>
                `CSP violation: ${violation.directive} blocked ${violation.blockedUri || '(inline)'} in ${violation.sourceFile || '(document)'}`,
        ),
        ...report.policyMessages.map((message) => `policy message: ${message}`),
        ...report.pageErrors.map((error) => `uncaught error: ${error}`),
        ...report.foreignRequests.map((url) => `request to another origin: ${url}`),
        ...report.dialogs.map((dialog) => `native dialog: ${dialog}`),
    ];
}
