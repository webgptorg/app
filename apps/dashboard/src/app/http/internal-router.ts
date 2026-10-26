import { EngineId, RegistryEntry } from '@ptbk/protocol';
import { Hono } from 'hono';
import { z } from 'zod';

import { recordPresence } from '../../domain/presence/relay-presence';
import { readRegistryEntry } from '../../domain/registry/read-registry-entry';
import { defineRoute, NO_CONTENT, NO_INPUT } from '../../shared/api/contract';
import {
    RELAY_PRESENCE_MAX_BODY_BYTES,
    RELAY_PRESENCE_PATH,
    RelayPresenceReport,
} from '../../shared/api/relay-presence';
import type { DashboardDeps } from '../deps';
import type { RouteBinder } from './bind-route';

export const INTERNAL_MOUNT = '/internal';

/** C-03's Interface 2: `registryPath(engineId)`, read by every relay at tunnel auth and once per registry TTL. */
export const registryRoute = defineRoute({
    method: 'GET',
    path: '/internal/v1/engines/:engineId',
    auth: 'relay-token',
    permission: null,
    rateLimit: 'registry-relay',
    input: { ...NO_INPUT, params: z.strictObject({ engineId: EngineId }) },
    output: RegistryEntry,
    errorCodes: [],
});

/**
 * R-07: a relay's full list of engines with a ready tunnel, about once a minute. The relay is the key's, never a body
 * field; a relay outside `RELAYS` is refused, since engines never dial it.
 */
export const presenceRoute = defineRoute({
    method: 'PUT',
    path: RELAY_PRESENCE_PATH,
    auth: 'relay-token',
    permission: null,
    rateLimit: 'presence-relay',
    input: { ...NO_INPUT, body: RelayPresenceReport, maxBodyBytes: RELAY_PRESENCE_MAX_BODY_BYTES },
    output: NO_CONTENT,
    errorCodes: ['unknown-relay'],
});

/** Machine API for relays, authenticated with a relay key. Cookies are never read here. */
export function createInternalRouter(
    deps: Pick<DashboardDeps, 'config' | 'clock' | 'logger' | 'registry' | 'engineHostnames' | 'relayPresence'> & {
        readonly routes: RouteBinder;
    },
): Hono {
    const router = new Hono();
    const reader = { ...deps, engineDomain: deps.config.engineDomain };
    const presence = {
        ...deps,
        relayIds: new Set<string>(deps.config.relays.map((relay) => relay.relayId)),
    };
    deps.routes.bind(router, INTERNAL_MOUNT, registryRoute, async ({ input }) => {
        const outcome = await readRegistryEntry(reader, input.params.engineId);
        switch (outcome.kind) {
            case 'found':
                // Strict on the way out (rule 5): an undeclared field fails here rather than reaching a relay.
                return { kind: 'ok', body: RegistryEntry.parse(outcome.entry) };
            case 'not-found':
                return { kind: 'problem', status: 404, code: 'not-found' };
        }
    });
    deps.routes.bind(router, INTERNAL_MOUNT, presenceRoute, async ({ input, relay }) => {
        const outcome = await recordPresence(presence, relay.relayId, input.body.engineIds);
        switch (outcome.kind) {
            case 'recorded':
                return { kind: 'ok', body: undefined, status: 204 };
            case 'unknown-relay':
                return { kind: 'problem', status: 403, code: 'unknown-relay' };
        }
    });
    return router;
}
