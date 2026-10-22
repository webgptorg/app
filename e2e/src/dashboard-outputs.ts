// What the dashboard scenario reads from its services: the dev outbox, the mock engine's register report, request
// URLs. Kept apart from the Playwright fixtures so the unit tests need no browser.
import { ENGINE_DOMAIN } from './stack.ts';

export type RegisterReport =
    | {
          readonly outcome: 'registered' | 'already-registered';
          readonly engineId: string;
          readonly hostname: string;
          readonly relays: readonly string[];
      }
    | { readonly outcome: 'rejected' | 'refused-response'; readonly reason: string }
    | { readonly outcome: 'unavailable' };

let emailCounter = 0;

/** A new address per call: sign-up is email first, and each test signs up its own account. */
export function uniqueEmail(label: string): string {
    emailCounter += 1;
    return `x05-${label}-${String(Date.now())}-${String(emailCounter)}@example.test`;
}

/** Whether a request URL goes to an engine hostname (the engine domain or a name under it). */
export function isEngineUrl(url: string): boolean {
    const host = URL.parse(url)?.hostname ?? '';
    return host === ENGINE_DOMAIN || host.endsWith(`.${ENGINE_DOMAIN}`);
}

export function parseRegisterReport(stdout: string): RegisterReport {
    const line = stdout.trim().split('\n').at(-1) ?? '';
    const report = JSON.parse(line) as { outcome?: unknown } | null;
    if (typeof report?.outcome !== 'string') throw new Error('the register command printed no report');
    return report as RegisterReport;
}

/** The newest emailed link of `template` sent to `email`, from the dashboard's dev outbox (`/api/__dev/emails`). */
export function emailedLink(outbox: string, template: string): string | undefined {
    const emails = (JSON.parse(outbox) as { emails?: unknown } | null)?.emails;
    if (!Array.isArray(emails)) throw new Error('unexpected outbox answer');
    const texts = (emails as { template?: unknown; text?: unknown }[])
        .filter((email) => email.template === template && typeof email.text === 'string')
        .map((email) => email.text as string);
    return texts.at(-1)?.match(/https:\/\/\S+#[A-Za-z0-9_-]{43}/)?.[0];
}
