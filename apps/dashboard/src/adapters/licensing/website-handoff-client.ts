import { readBoundedJson } from './read-bounded-json';
import { z } from 'zod';
import type { WebsiteIdentity } from '../../domain/licensing/website-handoff';
const responseSchema = z.object({
    version: z.literal(1),
    subject: z.string().uuid(),
    email: z.string().email().max(254),
    emailVerified: z.literal(true),
});
/** Challenge comes from an HttpOnly App cookie created before redirecting to the website. */
export async function exchangeWebsiteTicket(input: {
    readonly code: string;
    readonly challenge: string;
    readonly secret: string;
    readonly fetch: typeof fetch;
    readonly signal: AbortSignal;
}): Promise<WebsiteIdentity | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.code) || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) return null;
    try {
        const response = await input.fetch('https://www.ptbk.io/api/promptbook-billing/app/exchange', {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            headers: {
                authorization: `Bearer ${input.secret}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ code: input.code, challenge: input.challenge }),
            signal: AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]),
        });
        if (!response.ok) return null;
        const parsed = responseSchema.safeParse(await readBoundedJson(response, 4096));
        if (!parsed.success) return null;
        return {
            subject: parsed.data.subject,
            email: parsed.data.email,
            emailVerified: true,
        };
    } catch {
        return null;
    }
}
