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

export interface OutboxEmail {
    readonly template: string;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
}

/** Every email in a dev outbox answer, oldest first; entries without the fields read here are refused. */
export function outboxEmails(outbox: string): readonly OutboxEmail[] {
    const emails = (JSON.parse(outbox) as { emails?: unknown } | null)?.emails;
    if (!Array.isArray(emails)) throw new Error('unexpected outbox answer');
    return emails.map((email: unknown) => {
        const { template, to, subject, text } = (email ?? {}) as Record<string, unknown>;
        if (
            typeof template !== 'string' ||
            typeof to !== 'string' ||
            typeof subject !== 'string' ||
            typeof text !== 'string'
        ) {
            throw new Error('unexpected outbox email');
        }
        return { template, to, subject, text };
    });
}

const DEV_INSTALL_COMMAND = /^bun run dev:link ([a-z2-7]{26})$/;

/** The link code in the installer tab's dev command (`bun run dev:link <code>`, wrangler.jsonc's dev config). */
export function devInstallLinkCode(command: string): string {
    const code = DEV_INSTALL_COMMAND.exec(command.trim())?.[1];
    if (code === undefined) throw new Error('the installer tab shows no dev install command');
    return code;
}

export interface TerminalIdentity {
    readonly engineId: string;
    readonly hostname: string;
    readonly fingerprint: string;
}

/** The identity lines the engine's `connect` prints, so the operator can compare them with the dashboard's. */
export function terminalIdentity(stdout: string): TerminalIdentity {
    const engineId = /^\s*Engine ID\s+(\S+)$/m.exec(stdout)?.[1];
    const hostname = /^\s*Address\s+https:\/\/(\S+)$/m.exec(stdout)?.[1];
    const fingerprint = /^\s*Fingerprint\s+(\S+)\s/m.exec(stdout)?.[1];
    if (engineId === undefined || hostname === undefined || fingerprint === undefined) {
        throw new Error('the engine printed no identity');
    }
    return { engineId, hostname, fingerprint };
}

export interface SetupLink {
    readonly url: string;
    /** The fragment: whoever holds it becomes the owner, so it must never reach a log. */
    readonly secret: string;
}

/** `setup-link --json` and `owner --reset --json` end with the link as one JSON object on stdout. */
export function parseSetupLink(stdout: string): SetupLink {
    const line = stdout.trim().split('\n').at(-1) ?? '';
    const answer = JSON.parse(line) as { outcome?: unknown; url?: unknown } | null;
    if (answer?.outcome !== 'created' || typeof answer.url !== 'string') {
        throw new Error(`no setup link: ${String(answer?.outcome)}`);
    }
    const secret = new URL(answer.url).hash.slice(1);
    if (secret === '') throw new Error('the setup link carries no secret');
    return { url: answer.url, secret };
}

/** Consecutive repeats dropped: the states a page went through, in order. */
export function distinctInOrder<T>(values: readonly T[]): readonly T[] {
    return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}
