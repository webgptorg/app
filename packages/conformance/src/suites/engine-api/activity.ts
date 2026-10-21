import { ENGINE_API_ROUTES, parseActivity } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, fail } from '../../check';
import { describe } from './api';
import { checkStableWalk } from './capability-support';
import { SUITE, attempt } from './support';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
const PAGES = 10;
const PAGE_LIMIT = 100;
const decoder = new TextDecoder();

/** The feed as sent, before any reading: one bad item must be reported, not fail the page. */
async function rawItems(world: Awaited<ReturnType<typeof createWorld>>, query: Readonly<Record<string, string>>) {
    const items: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < PAGES; page++) {
        const response = await world.owner.send(R.listActivity, {
            query: { ...query, limit: PAGE_LIMIT, ...(cursor === null ? {} : { cursor }) },
        });
        if (response.status !== 200) fail(`${describe(R.listActivity)}: status ${String(response.status)}`);
        const body = JSON.parse(decoder.decode(response.bytes)) as { items?: unknown; nextCursor?: unknown };
        if (!Array.isArray(body.items)) fail(`${describe(R.listActivity)}: no items`);
        items.push(...(body.items as unknown[]));
        cursor = typeof body.nextCursor === 'string' ? body.nextCursor : null;
        if (cursor === null) break;
    }
    return items;
}

export const ACTIVITY_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.activity.known-items',
        suite: SUITE,
        title: 'Every activity item is a kind and version this contract knows, valid against its schema',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const items = await rawItems(world, {});
            for (const item of items) {
                const parsed = parseActivity(item);
                switch (parsed.kind) {
                    case 'known':
                        break;
                    case 'unknown':
                        findings.add(
                            `GET /activity: ${parsed.base.id} is ${parsed.base.kind} v${String(parsed.base.v)}, not in this contract`,
                        );
                        break;
                    case 'invalid':
                        findings.add(
                            `GET /activity: ${parsed.base.id} (${parsed.base.kind}) breaks its schema at ${parsed.issues.map(({ path }) => path).join(', ')}`,
                        );
                        break;
                    case 'dropped':
                        findings.add('GET /activity: an item has no valid kind, version, ID, time, agent or actor');
                        break;
                }
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.activity.paging',
        suite: SUITE,
        title: 'GET /activity pages without gaps or duplicates, newest first, and a kind prefix lists only that area',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            // Activity keeps coming; nothing that happened before now joins or leaves this list.
            const to = new Date().toISOString();
            await attempt(findings, () => checkStableWalk(world, findings, R.listActivity, { to }));
            await attempt(findings, async () => {
                const items = (await rawItems(world, { kind: 'run.', to })).flatMap((item) => {
                    const parsed = parseActivity(item);
                    if (parsed.kind === 'dropped') return [];
                    return [parsed.kind === 'known' ? parsed.activity : parsed.base];
                });
                const stray = items.find(({ kind }) => !kind.startsWith('run.'));
                if (stray !== undefined) findings.add(`GET /activity?kind=run.: listed ${stray.kind}`);
                const times = items.map(({ at }) => Date.parse(at));
                if (times.some((at, index) => index > 0 && at > (times[index - 1] ?? at))) {
                    findings.add('GET /activity: items are not newest first');
                }
            });
            return findings.outcome();
        },
    },
];
