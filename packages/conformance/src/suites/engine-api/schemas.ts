import { ENGINE_API_ROUTE_LIST, ENGINE_API_ROUTES } from '@ptbk/engine-api';
import type { RouteDefinition } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings } from '../../check';
import { BROKEN_BOOK } from '../../fixtures/books';
import type { EngineApi } from './api';
import { describe, successOf } from './api';
import { placeholderRequest } from './requests';
import { SUITE, attempt } from './support';
import type { World } from './world';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;

/** How long an endless stream (`/events`) is read before the check moves on. */
export const EVENT_WINDOW_MS = 1500;

/** Reads one GET route the way the UI would and lets the client judge it strictly; draft routes may be absent. */
export async function readRoute(
    world: World,
    api: EngineApi,
    route: RouteDefinition,
    findings: Findings,
): Promise<void> {
    const params = await world.paramsFor(route);
    if (params === null) return;
    if (successOf(route).response.kind === 'sse') {
        const endless = route.id === R.streamEvents.id;
        await api.stream(route, { params }, { maxMs: endless ? EVENT_WINDOW_MS : 30_000 });
        return;
    }
    const result = await api.call(route, { params });
    if (result.kind === 'problem' && !(route.draft === true && result.problem.code === 'not-found')) {
        findings.add(`${describe(route)}: expected success, got ${String(result.status)} ${result.problem.code}`);
    }
}

export const SCHEMA_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.schemas.responses-strict',
        suite: SUITE,
        title: "Every successful response parses with its route's strict schema: no undeclared fields",
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            for (const route of ENGINE_API_ROUTE_LIST) {
                if (route.method !== 'GET' || !(await world.advertises(route))) continue;
                await attempt(findings, () => readRoute(world, world.owner, route, findings));
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.schemas.problems',
        suite: SUITE,
        title: 'Every 4xx and 5xx is application/problem+json with a known code and the status that code has',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            for (const route of ENGINE_API_ROUTE_LIST) {
                if (route.method !== 'GET' || route.params === undefined || !(await world.advertises(route))) continue;
                await attempt(findings, async () => {
                    const { params } = await placeholderRequest(route, null);
                    await world.owner.problem(route, params === undefined ? {} : { params }, 'not-found');
                });
            }
            await attempt(findings, async () => {
                const problem = await world.owner.problem(
                    R.createAgent,
                    { body: { source: BROKEN_BOOK } },
                    'invalid-book',
                );
                if (!problem.diagnostics?.some(({ severity }) => severity === 'error')) {
                    findings.add('POST /agents: invalid-book carries no error diagnostic');
                }
            });
            await attempt(findings, async () => {
                await world.owner.problem(R.createFolder, { body: { name: 42 } }, 'validation-failed');
            });
            await attempt(findings, async () => {
                await world.owner.problem(UNKNOWN_ROUTE, {}, 'not-found');
            });
            return findings.outcome();
        },
    },
];

/** A path under the API prefix that no contract version defines. */
const UNKNOWN_ROUTE: RouteDefinition = {
    id: 'conformanceUnknownRoute',
    method: 'GET',
    path: '/conformance-no-such-route',
    summary: 'Not part of the contract',
    permission: null,
    responses: { 200: { kind: 'empty' } },
};
