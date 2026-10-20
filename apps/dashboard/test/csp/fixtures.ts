import AxeBuilder from '@axe-core/playwright';
import { test as base, expect } from '@playwright/test';
import type { APIRequestContext, CDPSession, Page } from '@playwright/test';

export { expect };

const NARROW_VIEWPORT = { width: 360, height: 740 } as const;

interface CspViolation {
    readonly directive: string;
    readonly blockedUri: string;
    readonly sourceFile: string;
}

declare global {
    interface Window {
        /** Exposed by Playwright (a CDP binding, so not script the CSP governs); the SPA never calls it. */
        __reportCspViolation?: (violation: CspViolation) => void;
    }
}

/** What the browser reported while a test ran; every list must stay empty. */
export interface BrowserReport {
    /** `securitypolicyviolation` events, Trusted Types refusals included. */
    readonly cspViolations: readonly CspViolation[];
    /** Console errors that are about CSP or Trusted Types (a 401 from `GET /api/session` is expected noise). */
    readonly cspConsoleErrors: readonly string[];
    readonly pageErrors: readonly string[];
    readonly foreignRequests: readonly string[];
}

/** One screen's checks: axe (every impact), and no horizontal scroll at 360 px or on the desktop viewport. */
export interface ScreenReport {
    readonly axeViolations: readonly string[];
    readonly overflowPx: number;
    readonly wideOverflowPx: number;
}

export function expectCleanScreen(report: ScreenReport, screen: string): void {
    expect.soft(report.axeViolations, `axe violations on ${screen}`).toEqual([]);
    expect.soft(report.overflowPx, `horizontal overflow at 360 px on ${screen}`).toBeLessThanOrEqual(0);
    expect.soft(report.wideOverflowPx, `horizontal overflow at 1280 px on ${screen}`).toBeLessThanOrEqual(0);
}

export function expectNoBrowserErrors(report: BrowserReport): void {
    expect.soft(report.cspViolations, 'CSP violations').toEqual([]);
    expect.soft(report.cspConsoleErrors, 'CSP console errors').toEqual([]);
    expect.soft(report.pageErrors, 'uncaught page errors').toEqual([]);
    expect.soft(report.foreignRequests, 'requests to other origins').toEqual([]);
}

/** Chromium's virtual WebAuthn authenticators over CDP: a platform authenticator with user verification. */
export interface Authenticators {
    add(): Promise<string>;
    remove(id: string): Promise<void>;
}

interface Fixtures {
    /** Violations of every document the page loaded in this test, collected as they happen. */
    cspViolations: CspViolation[];
    /** Everything the browser reported so far in this test. */
    browserReport: () => BrowserReport;
    checkScreen: (name: string) => Promise<void>;
    authenticators: Authenticators;
}

export const test = base.extend<Fixtures>({
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern.
    cspViolations: async ({}, use) => {
        await use([]);
    },

    page: async ({ page, cspViolations }, use) => {
        await page.exposeFunction('__reportCspViolation', (violation: CspViolation) => {
            cspViolations.push(violation);
        });
        await page.addInitScript(() => {
            document.addEventListener('securitypolicyviolation', (event) => {
                window.__reportCspViolation?.({
                    directive: event.effectiveDirective,
                    blockedUri: event.blockedURI,
                    sourceFile: event.sourceFile,
                });
            });
        });
        await use(page);
    },

    browserReport: async ({ page, baseURL, cspViolations }, use) => {
        const origin = new URL(baseURL ?? '').origin;
        const cspConsoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const foreignRequests: string[] = [];
        page.on('console', (message) => {
            if (
                message.type() === 'error' &&
                /Content Security Policy|Trusted ?Type|Refused to/i.test(message.text())
            ) {
                cspConsoleErrors.push(message.text());
            }
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('request', (request) => {
            if (new URL(request.url()).origin !== origin) foreignRequests.push(request.url());
        });
        await use(() => ({
            cspViolations: [...cspViolations],
            cspConsoleErrors: [...cspConsoleErrors],
            pageErrors: [...pageErrors],
            foreignRequests: [...foreignRequests],
        }));
    },

    checkScreen: async ({ page }, use) => {
        await use(async (name) => {
            await page.waitForLoadState('networkidle');
            const axe = await new AxeBuilder({ page }).analyze();
            const axeViolations = axe.violations.map(
                (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
            );
            const wideOverflowPx = await measureOverflow(page);
            const viewport = page.viewportSize();
            await page.setViewportSize(NARROW_VIEWPORT);
            const overflowPx = await measureOverflow(page);
            const narrowAxe = await new AxeBuilder({ page }).analyze();
            axeViolations.push(...narrowAxe.violations.map((violation) => `360px ${violation.id}`));
            if (viewport !== null) await page.setViewportSize(viewport);
            expectCleanScreen({ axeViolations, overflowPx, wideOverflowPx }, name);
        });
    },

    authenticators: async ({ page }, use) => {
        const cdp: CDPSession = await page.context().newCDPSession(page);
        await cdp.send('WebAuthn.enable');
        await use({
            add: async () => {
                const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
                    options: {
                        protocol: 'ctap2',
                        transport: 'internal',
                        hasResidentKey: true,
                        hasUserVerification: true,
                        isUserVerified: true,
                        automaticPresenceSimulation: true,
                    },
                });
                return authenticatorId;
            },
            remove: async (authenticatorId) => {
                await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
            },
        });
    },
});

function measureOverflow(page: Page): Promise<number> {
    return page.evaluate(
        () =>
            new Promise<number>((resolve) => {
                requestAnimationFrame(() => {
                    resolve(document.documentElement.scrollWidth - document.documentElement.clientWidth);
                });
            }),
    );
}

const outboxSchema = (value: unknown): readonly { template: string; text: string }[] => {
    const emails = (value as { emails?: unknown }).emails;
    if (!Array.isArray(emails)) throw new Error('unexpected outbox answer');
    return emails as { template: string; text: string }[];
};

/** The newest link of `template` sent to `email`, from the dev outbox (`GET /api/__dev/emails`, dev only). */
export async function outboxLink(
    request: APIRequestContext,
    email: string,
    template: 'signup-link' | 'recovery-link',
): Promise<string> {
    let link: string | undefined;
    await expect
        .poll(async () => {
            const response = await request.get(`/api/__dev/emails?to=${encodeURIComponent(email)}`);
            const emails = outboxSchema(await response.json()).filter((candidate) => candidate.template === template);
            link = emails.at(-1)?.text.match(/https?:\/\/\S+#[A-Za-z0-9_-]{43}/)?.[0];
            return link;
        })
        .toBeDefined();
    if (link === undefined) throw new Error('no link');
    return link;
}

let counter = 0;
export function uniqueEmail(label: string): string {
    counter += 1;
    return `d09-${label}-${String(Date.now())}-${String(counter)}@example.test`;
}
