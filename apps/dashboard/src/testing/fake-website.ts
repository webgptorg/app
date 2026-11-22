import type { LicenseGrant, LicenseSnapshot } from '../domain/licensing/license-contract';
import type { WebsiteIdentity } from '../domain/licensing/website-handoff';

export const FAKE_WEBSITE_ORIGIN = 'https://www.ptbk.io';
export const FAKE_HANDOFF_URL = `${FAKE_WEBSITE_ORIGIN}/cs/app/pripojit`;
const TICKET_TTL_MS = 60_000;

interface Ticket {
    readonly challenge: string;
    readonly identity: WebsiteIdentity;
    readonly expiresAt: number;
    used: boolean;
}

/**
 * The website's App API as `webgptorg/ptbk-landing-page-aldaron` implements it: a bearer secret, single-use 60-second
 * tickets bound to the App's challenge (403 for unknown, used, expired or mismatched alike), and licence snapshots.
 */
export interface FakeWebsite {
    readonly fetch: typeof fetch;
    /** What the website's handoff page does for a signed-in member: a ticket for this challenge. */
    issueTicket(challenge: string, identity: WebsiteIdentity): string;
    setGrants(subject: string, grants: readonly LicenseGrant[]): void;
    /** Every licence read answers this status until cleared, as during an outage. */
    outage: number | null;
    readonly calls: string[];
}

export function createFakeWebsite(options: { readonly secret: string; readonly nowMs: () => number }): FakeWebsite {
    const tickets = new Map<string, Ticket>();
    const grants = new Map<string, readonly LicenseGrant[]>();
    const calls: string[] = [];
    let issued = 0;
    const website: FakeWebsite = {
        outage: null,
        calls,
        issueTicket(challenge, identity) {
            issued++;
            const code = `ticket${String(issued)}`.padEnd(43, 'x');
            tickets.set(code, { challenge, identity, expiresAt: options.nowMs() + TICKET_TTL_MS, used: false });
            return code;
        },
        setGrants(subject, list) {
            grants.set(subject, list);
        },
        async fetch(input, init) {
            const url = new URL(input instanceof Request ? input.url : input.toString());
            calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
            if (new Headers(init?.headers).get('authorization') !== `Bearer ${options.secret}`) {
                return Response.json({ error: 'Unauthorized' }, { status: 401 });
            }
            if (url.pathname === '/api/promptbook-billing/app/exchange') {
                const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
                    code: string;
                    challenge: string;
                };
                const ticket = tickets.get(body.code);
                if (
                    ticket === undefined ||
                    ticket.used ||
                    ticket.challenge !== body.challenge ||
                    ticket.expiresAt <= options.nowMs()
                ) {
                    return Response.json({ error: 'Invalid ticket' }, { status: 403 });
                }
                ticket.used = true;
                return Response.json({ version: 1, ...ticket.identity });
            }
            if (url.pathname === '/api/promptbook-billing/app/licenses') {
                if (website.outage !== null) {
                    return Response.json({ error: 'Temporarily unavailable' }, { status: website.outage });
                }
                const subject = url.searchParams.get('subject') ?? '';
                const list = grants.get(subject);
                if (list === undefined) return Response.json({ error: 'Not found' }, { status: 404 });
                const snapshot: LicenseSnapshot = {
                    version: 1,
                    subject,
                    generatedAt: new Date(options.nowMs()).toISOString(),
                    refreshAfterSeconds: 900,
                    enforcement: 'advisory',
                    manageUrl: `${FAKE_WEBSITE_ORIGIN}/cs/pricing/predplatne`,
                    grants: [...list],
                };
                return Response.json(snapshot);
            }
            await Promise.resolve();
            return new Response(null, { status: 404 });
        },
    };
    return website;
}
