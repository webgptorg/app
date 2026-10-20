import { ENGINE_API_ROUTES } from '@ptbk/engine-api';
import type { RouteDefinition } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings } from '../../check';
import { randomToken } from '../../random';
import { describe } from './api';
import { SUITE, attempt, walkPages } from './support';
import type { World } from './world';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
const PAGE_LIMIT = 2;
/** One more than fits in two pages, so the walk needs three and the last one is partial. */
const CREATED = PAGE_LIMIT + 3;

/**
 * Walks `route` with `limit` 2 and checks that every page respects the limit, no item comes twice, every created item
 * comes once, and the last page ends with `nextCursor: null`.
 */
async function checkWalk(
    world: World,
    findings: Findings,
    route: RouteDefinition,
    query: Readonly<Record<string, string>>,
    created: readonly string[],
): Promise<void> {
    const { pages, complete } = await walkPages(world.owner, route, { ...query, limit: PAGE_LIMIT });
    const where = describe(route);
    if (!complete) findings.add(`${where}: the walk never reached nextCursor null`);
    const seen = new Map<string, number>();
    pages.forEach((page, index) => {
        if (page.length > PAGE_LIMIT)
            findings.add(`${where}: page ${String(index + 1)} has ${String(page.length)} items`);
        for (const { id } of page) seen.set(id, (seen.get(id) ?? 0) + 1);
    });
    for (const [id, count] of seen) if (count > 1) findings.add(`${where}: ${id} appears on ${String(count)} pages`);
    const missing = created.filter((id) => !seen.has(id));
    if (missing.length > 0) findings.add(`${where}: ${String(missing.length)} created items never appear`);
}

export const PAGINATION_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.pagination.walk',
        suite: SUITE,
        title: `Walking ${String(CREATED)} new items with limit ${String(PAGE_LIMIT)}: no duplicates, no gaps, a final null cursor`,
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const label = `page-${randomToken(ctx.random, 6)}`;
            // `World.name` prefixes `conformance-<runId>-`, so this matches every item made from `label`.
            const tag = `conformance-${ctx.runId}-${label}`;
            await attempt(findings, async () => {
                const agents: string[] = [];
                for (let index = 0; index < CREATED; index++) agents.push((await world.createAgent(label)).id);
                await checkWalk(world, findings, R.listAgents, { q: tag }, agents);
            });
            await attempt(findings, async () => {
                const secrets: string[] = [];
                for (let index = 0; index < CREATED; index++) {
                    secrets.push((await world.createSecret(label, randomToken(ctx.random, 32))).id);
                }
                await checkWalk(world, findings, R.listSecrets, { q: tag }, secrets);
            });
            await attempt(findings, async () => {
                const folders: string[] = [];
                for (let index = 0; index < CREATED; index++) folders.push((await world.createFolder(label)).id);
                await checkWalk(world, findings, R.listFolders, {}, folders);
            });
            return findings.outcome();
        },
    },
];
