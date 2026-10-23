import { describe, expect, it } from 'vitest';

import { createAnalyticsEngineQuery } from './analytics-engine-query';

const ACCOUNT = 'f'.repeat(32);
const TOKEN = 'T'.repeat(40);

function query(answer: () => Response) {
    const requests: { url: string; init: RequestInit }[] = [];
    const adapter = createAnalyticsEngineQuery({
        accountId: ACCOUNT,
        dataset: 'ptbk_ops_staging',
        token: TOKEN,
        fetch: (url, init) => {
            requests.push({ url, init });
            return Promise.resolve(answer());
        },
    });
    return { adapter, requests };
}

const signal = new AbortController().signal;

describe('createAnalyticsEngineQuery', () => {
    it('sums heartbeats and emails by outcome over the window, with the read token', async () => {
        const { adapter, requests } = query(() =>
            Response.json({
                meta: [],
                data: [
                    { name: 'ptbk_dashboard_heartbeats_total', outcome: 'accepted', n: '120' },
                    { name: 'ptbk_dashboard_heartbeats_total', outcome: 'bad-signature', n: 7 },
                    { name: 'ptbk_dashboard_heartbeats_total', outcome: 'stale-ts', n: 3 },
                    { name: 'ptbk_dashboard_emails_total', outcome: 'sent', n: 2 },
                    { name: 'ptbk_dashboard_emails_total', outcome: 'failed', n: 1 },
                ],
                rows: 5,
            }),
        );
        await expect(adapter.dashboardCounts(10, signal)).resolves.toEqual({
            heartbeatsAccepted: 120,
            heartbeatsRejected: 10,
            emailsSent: 2,
            emailsFailed: 1,
        });
        const [request] = requests;
        expect(request?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`);
        expect(request?.init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
        expect(request?.init.body).toContain("INTERVAL '10' MINUTE");
        expect(request?.init.body).toContain('FROM ptbk_ops_staging');
    });

    it('rejects on an error status, an oversized or malformed answer, and a bad window', async () => {
        await expect(
            query(() => new Response('', { status: 403 })).adapter.dashboardCounts(10, signal),
        ).rejects.toThrow('403');
        await expect(query(() => new Response('x'.repeat(70_000))).adapter.dashboardCounts(10, signal)).rejects.toThrow(
            'too large',
        );
        await expect(
            query(() => Response.json({ data: [{ name: 'x', outcome: 'y', n: -1 }] })).adapter.dashboardCounts(
                10,
                signal,
            ),
        ).rejects.toThrow();
        await expect(query(() => Response.json({ data: [] })).adapter.dashboardCounts(0, signal)).rejects.toThrow(
            RangeError,
        );
    });

    it('refuses a dataset name it would have to quote', () => {
        expect(() =>
            createAnalyticsEngineQuery({
                accountId: ACCOUNT,
                dataset: 'x; DROP',
                token: TOKEN,
                fetch: () => Promise.reject(new Error()),
            }),
        ).toThrow('dataset');
    });
});
