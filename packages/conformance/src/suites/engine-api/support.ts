import { ENGINE_API_ROUTES } from '@ptbk/engine-api';
import type { EngineApiRouteId, RouteDefinition, RouteEngineData } from '@ptbk/engine-api';

import { CheckFailure } from '../../check';
import type { CheckContext, Findings } from '../../check';
import type { ApiResult, EngineApi } from './api';

export const SUITE = 'engine-api';

/** Runs one part of a check; a contract violation becomes a finding instead of ending the check. */
export async function attempt(findings: Findings, task: () => Promise<void>): Promise<void> {
    try {
        await task();
    } catch (error) {
        if (error instanceof CheckFailure) findings.add(error.message);
        else throw error;
    }
}

export function isMutation(route: RouteDefinition): boolean {
    return route.method !== 'GET';
}

/** What a route created, and how to remove it again, for creations a check did not expect to succeed. */
const CREATED: Partial<Record<EngineApiRouteId, { readonly route: RouteDefinition; readonly param: string }>> = {
    createAgent: { route: ENGINE_API_ROUTES.deleteAgent, param: 'agentId' },
    createFolder: { route: ENGINE_API_ROUTES.deleteFolder, param: 'folderId' },
    createSecret: { route: ENGINE_API_ROUTES.deleteSecret, param: 'secretId' },
    createApiToken: { route: ENGINE_API_ROUTES.revokeApiToken, param: 'apiTokenId' },
    uploadFile: { route: ENGINE_API_ROUTES.deleteFile, param: 'fileId' },
    createTrigger: { route: ENGINE_API_ROUTES.deleteTrigger, param: 'triggerId' },
    createIntegration: { route: ENGINE_API_ROUTES.deleteIntegration, param: 'integrationId' },
};

/** Removes, after the check, whatever a request that should have been refused created anyway. */
export function cleanUpUnexpected(
    ctx: CheckContext,
    owner: EngineApi,
    route: RouteDefinition,
    result: ApiResult<unknown>,
): void {
    const created = CREATED[route.id as EngineApiRouteId];
    if (result.kind !== 'ok' || created === undefined) return;
    const data = result.data as { readonly id?: unknown; readonly apiToken?: { readonly id?: unknown } };
    const id = data.id ?? data.apiToken?.id;
    if (typeof id !== 'string') return;
    ctx.resources.defer((signal) => owner.withSignal(signal).send(created.route, { params: { [created.param]: id } }));
}

/** The item type of a paged route; `{ id }` for routes typed only as `RouteDefinition`. */
export type PageItem<Route> =
    RouteEngineData<Route> extends { readonly items: readonly (infer Item)[] } ? Item : { readonly id: string };

/** Calls each page of a list route until `nextCursor` is `null`; `maxPages` guards against an endless walk. */
export async function walkPages<Route extends RouteDefinition>(
    api: EngineApi,
    route: Route,
    query: Readonly<Record<string, string | number>>,
    maxPages = 100,
): Promise<{ readonly pages: readonly (readonly PageItem<Route>[])[]; readonly complete: boolean }> {
    type Item = PageItem<Route>;
    const pages: Item[][] = [];
    let cursor: string | null = null;
    for (let index = 0; index < maxPages; index++) {
        const page = (await api.ok(route, { query: { ...query, ...(cursor === null ? {} : { cursor }) } })) as {
            readonly items: readonly Item[];
            readonly nextCursor: string | null;
        };
        pages.push([...page.items]);
        if (page.nextCursor === null) return { pages, complete: true };
        cursor = page.nextCursor;
    }
    return { pages, complete: false };
}
