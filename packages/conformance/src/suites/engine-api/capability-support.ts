import { supports } from '@ptbk/engine-api';
import type { CapabilityRef, RouteDefinition } from '@ptbk/engine-api';

import { skip } from '../../check';
import type { Findings } from '../../check';
import { describe } from './api';
import { walkPages } from './support';
import type { World } from './world';

/** The reason every check of a capability the target does not list in `GET /engine` skips with. */
export const CAPABILITY_NOT_ADVERTISED = 'capability-not-advertised';

export async function requireCapability(world: World, capability: CapabilityRef): Promise<void> {
    if (!supports(await world.engine(), capability)) skip(CAPABILITY_NOT_ADVERTISED);
}

/** Pages the walk compares against one large page. */
const WALK_PAGES = 12;
const WALK_LIMIT = 3;

/**
 * Walks `route` in small pages and compares the IDs with one large page of the same query: same items, same order,
 * no duplicates, no gaps. `query` must describe a set that does not change while the check runs (bounded in time,
 * created by the check), since engines keep working in the meantime.
 */
export async function checkStableWalk(
    world: World,
    findings: Findings,
    route: RouteDefinition,
    query: Readonly<Record<string, string>>,
): Promise<void> {
    const where = describe(route);
    const walked = await walkPages(world.owner, route, { ...query, limit: WALK_LIMIT }, WALK_PAGES);
    const ids = walked.pages.flat().map(({ id }) => id);
    const whole = (await world.owner.ok(route, { query: { ...query, limit: WALK_LIMIT * WALK_PAGES } })) as {
        readonly items: readonly { readonly id: string }[];
    };
    const expected = whole.items.map(({ id }) => id).slice(0, ids.length);
    if (new Set(ids).size !== ids.length) findings.add(`${where}: an item came on two pages`);
    if (walked.pages.some((page) => page.length > WALK_LIMIT)) findings.add(`${where}: a page exceeds the limit`);
    if (ids.join() !== expected.join()) {
        findings.add(`${where}: paging gave other items or another order than one large page`);
    }
}

/** `null` when every item matches, else a finding naming the first that does not. */
export function checkFilter<Item extends { readonly id: string }>(
    findings: Findings,
    route: RouteDefinition,
    filter: string,
    items: readonly Item[],
    matches: (item: Item) => boolean,
): void {
    const stray = items.find((item) => !matches(item));
    if (stray !== undefined) findings.add(`${describe(route)}: ${filter} listed ${stray.id}, which does not match`);
}
