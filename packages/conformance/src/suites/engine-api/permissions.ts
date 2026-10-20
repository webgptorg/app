import { ENGINE_API_ROUTE_LIST, ENGINE_API_ROUTES, PERMISSIONS, isReadPermission } from '@ptbk/engine-api';
import type { EngineApiRouteId, Permission, RouteDefinition } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, skip } from '../../check';
import type { ApiRequest, EngineApi } from './api';
import { describe } from './api';
import { AUDIT_EXPECTATIONS, findAuditEntry } from './audit';
import { snapshot } from './probes';
import { placeholderRequest, validRequest } from './requests';
import { readRoute } from './schemas';
import { SUITE, attempt, cleanUpUnexpected, isMutation } from './support';
import type { World } from './world';
import { allPermissionsExcept, committedRoutes, createWorld, sessionFor } from './world';

const R = ENGINE_API_ROUTES;

export interface Denial {
    readonly route: RouteDefinition;
    readonly request: ApiRequest;
    readonly memberId: string;
}

/** Every committed mutating route of an advertised capability that requires a permission. */
async function guardedMutations(world: World): Promise<readonly RouteDefinition[]> {
    const routes: RouteDefinition[] = [];
    for (const route of committedRoutes(ENGINE_API_ROUTE_LIST)) {
        if (isMutation(route) && route.permission !== null && (await world.advertises(route))) routes.push(route);
    }
    return routes;
}

/**
 * For every guarded mutation, a member holding every permission except the route's own sends a request the owner
 * could send successfully. It must get 403 problem+json `forbidden` naming that permission, and an owner read of what
 * the route would change must show nothing changed.
 */
export async function denyEveryMutation(world: World, findings: Findings): Promise<readonly Denial[]> {
    const members = new Map<Permission, { readonly api: EngineApi; readonly memberId: string }>();
    const memberWithout = async (permission: Permission) => {
        const known = members.get(permission);
        if (known) return known;
        const api = await sessionFor(
            world.ctx,
            { kind: 'member', permissions: allPermissionsExcept(permission, PERMISSIONS) },
            'members with chosen permissions',
        );
        const member = { api, memberId: (await api.ok(R.getMe)).memberId };
        members.set(permission, member);
        return member;
    };
    const denials: Denial[] = [];
    for (const route of await guardedMutations(world)) {
        const permission = route.permission as Permission;
        await attempt(findings, async () => {
            const member = await memberWithout(permission);
            const request = (await validRequest(route, world)) ?? (await placeholderRequest(route, world));
            const before = await snapshot(world.owner, route, request);
            const result = await member.api.call(route, request);
            denials.push({ route, request, memberId: member.memberId });
            if (result.kind === 'ok') {
                cleanUpUnexpected(world.ctx, world.owner, route, result);
                findings.add(`${describe(route)}: a member without ${permission} got ${String(result.status)}`);
            } else if (result.problem.code !== 'forbidden') {
                findings.add(
                    `${describe(route)}: a member without ${permission} got ${result.problem.code}, not forbidden`,
                );
            } else if (result.problem.requiredPermission !== permission) {
                findings.add(
                    `${describe(route)}: forbidden names ${result.problem.requiredPermission ?? 'no permission'}, not ${permission}`,
                );
            }
            if (before !== null && (await snapshot(world.owner, route, request)) !== before) {
                findings.add(`${describe(route)}: the refused request changed state`);
            }
        });
    }
    return denials;
}

export const PERMISSION_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.permissions.owner-holds-all',
        suite: SUITE,
        title: "The owner's /me lists every permission",
        async run(ctx) {
            const world = await createWorld(ctx);
            const held = new Set((await world.me()).permissions);
            const missing = PERMISSIONS.filter((permission) => !held.has(permission));
            const findings = new Findings();
            if (missing.length > 0) findings.add(`GET /me: the owner lacks ${missing.join(', ')}`);
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.permissions.mutations-denied',
        suite: SUITE,
        title: 'Every mutating route refuses a member without its permission with 403 forbidden, and changes nothing',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const denials = await denyEveryMutation(world, findings);
            if (denials.length === 0 && findings.count === 0) skip('no guarded mutation could be tried');
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.permissions.denials-audited',
        suite: SUITE,
        title: 'Each refused mutation is in /audit with outcome denied and the refused member',
        async run(ctx) {
            const world = await createWorld(ctx);
            const ignored = new Findings();
            const denials = await denyEveryMutation(world, ignored);
            const findings = new Findings();
            for (const { route, request, memberId } of denials) {
                const expected = AUDIT_EXPECTATIONS[route.id as EngineApiRouteId];
                if (expected === undefined) continue;
                const id =
                    expected.param === null || expected.param === 'created' ? null : request.params?.[expected.param];
                await attempt(findings, () =>
                    findAuditEntry(
                        world.owner,
                        {
                            route: describe(route),
                            action: expected.action,
                            target:
                                id === undefined || id === null || expected.kind === null
                                    ? null
                                    : { kind: expected.kind, id },
                            outcome: 'denied',
                            memberId,
                        },
                        findings,
                    ),
                );
            }
            if (denials.length === 0) skip('no guarded mutation could be tried');
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.permissions.read-only-member',
        suite: SUITE,
        title: 'A member holding only .read permissions can call every read route those permissions cover',
        async run(ctx) {
            const world = await createWorld(ctx);
            const readOnly = PERMISSIONS.filter(isReadPermission);
            const member = await sessionFor(
                ctx,
                { kind: 'member', permissions: readOnly },
                'members with chosen permissions',
            );
            const held = new Set<Permission>(readOnly);
            const findings = new Findings();
            for (const route of ENGINE_API_ROUTE_LIST) {
                if (route.method !== 'GET' || (route.permission !== null && !held.has(route.permission))) continue;
                if (!(await world.advertises(route))) continue;
                await attempt(findings, () => readRoute(world, member, route, findings));
            }
            return findings.outcome();
        },
    },
];
