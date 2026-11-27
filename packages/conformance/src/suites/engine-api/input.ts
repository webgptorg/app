import { ENGINE_API_ROUTE_LIST, MAX_PAGE_LIMIT } from '@ptbk/engine-api';
import type { ProblemCode, RouteDefinition } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, skip } from '../../check';
import type { ApiRequest } from './api';
import { describe } from './api';
import { validRequest, withUnknownField } from './requests';
import { SUITE, attempt, cleanUpUnexpected } from './support';
import type { World } from './world';
import { committedRoutes, createWorld } from './world';

/**
 * Sends `defective` for every route `pick` returns a request for and expects `code`. A route the engine guards with a
 * step-up the suite cannot give is left out, since the gateway may answer before the API reads the input.
 */
async function expectRefusal(
    world: World,
    routes: readonly RouteDefinition[],
    pick: (route: RouteDefinition) => Promise<ApiRequest | null>,
    code: ProblemCode,
): Promise<Findings> {
    const findings = new Findings();
    let tried = 0;
    for (const route of committedRoutes(routes)) {
        if (!(await world.advertises(route))) continue;
        await attempt(findings, async () => {
            const request = await pick(route);
            if (request === null) return;
            const result = await world.owner.call(route, request);
            if (result.kind === 'problem' && result.problem.code === 'step-up-required') return;
            tried++;
            if (result.kind === 'ok') {
                cleanUpUnexpected(world.ctx, world.owner, route, result);
                findings.add(`${describe(route)}: accepted it with ${String(result.status)}`);
            } else if (result.problem.code !== code) {
                findings.add(`${describe(route)}: answered ${result.problem.code} instead of ${code}`);
            }
        });
    }
    if (tried === 0 && findings.count === 0) skip('no route could be tried');
    return findings;
}

function pagedRoutes(): readonly RouteDefinition[] {
    return ENGINE_API_ROUTE_LIST.filter(
        (route) => route.method === 'GET' && route.query?.shape['cursor'] !== undefined,
    );
}

async function withQuery(world: World, route: RouteDefinition, query: Readonly<Record<string, string | number>>) {
    const params = await world.paramsFor(route);
    return params === null ? null : { params, query };
}

export const INPUT_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.input.unknown-body-field',
        suite: SUITE,
        title: 'A request body with a field the contract does not declare is refused with 400 validation-failed',
        async run(ctx) {
            const world = await createWorld(ctx);
            // A raw body has no fields to add one to.
            const routes = ENGINE_API_ROUTE_LIST.filter(
                (route) => route.body !== undefined && route.body.kind !== 'binary',
            );
            const findings = await expectRefusal(
                world,
                routes,
                async (route) => {
                    const request = await validRequest(route, world);
                    return request === null ? null : { ...request, body: withUnknownField(request.body) };
                },
                'validation-failed',
            );
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.input.limit-too-large',
        suite: SUITE,
        title: `A page limit above ${String(MAX_PAGE_LIMIT)} is refused with 400 validation-failed`,
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = await expectRefusal(
                world,
                pagedRoutes(),
                (route) => withQuery(world, route, { limit: MAX_PAGE_LIMIT + 1 }),
                'validation-failed',
            );
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.input.garbage-cursor',
        suite: SUITE,
        title: 'A cursor the engine never issued is refused with 400 invalid-cursor',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = await expectRefusal(
                world,
                pagedRoutes(),
                (route) => withQuery(world, route, { cursor: `conformance-${ctx.runId}-not-a-cursor` }),
                'invalid-cursor',
            );
            return findings.outcome();
        },
    },
];
