import { AGENT_ROUTES } from './agents';
import { API_TOKEN_ROUTES } from './api-tokens';
import { AUDIT_ROUTES } from './audit';
import { CHAT_ROUTES } from './chats';
import { ENGINE_ROUTES } from './engine';
import { EVENT_ROUTES } from './events';
import { FILE_ROUTES } from './files';
import { FOLDER_ROUTES } from './folders';
import { ME_ROUTES } from './me';
import { MEMBER_ROUTES } from './members';
import { PASSKEY_ROUTES } from './passkeys';
import type { ProblemCode } from './problem-codes';
import type { RouteDefinition } from './route';
import { SECRET_ROUTES } from './secrets';
import { SECURITY_ROUTES } from './security';
import { SESSION_ROUTES } from './sessions';
import { SETTINGS_ROUTES } from './settings';

/** Every operation of the engine API, keyed by operation ID: the single source for client, OpenAPI and conformance. */
export const ENGINE_API_ROUTES = {
    ...ME_ROUTES,
    ...ENGINE_ROUTES,
    ...AGENT_ROUTES,
    ...EVENT_ROUTES,
    ...FOLDER_ROUTES,
    ...CHAT_ROUTES,
    ...MEMBER_ROUTES,
    ...API_TOKEN_ROUTES,
    ...SETTINGS_ROUTES,
    ...PASSKEY_ROUTES,
    ...SESSION_ROUTES,
    ...SECRET_ROUTES,
    ...FILE_ROUTES,
    ...SECURITY_ROUTES,
    ...AUDIT_ROUTES,
} as const satisfies Readonly<Record<string, RouteDefinition>>;

export type EngineApiRouteId = keyof typeof ENGINE_API_ROUTES;
export type EngineApiRoute = (typeof ENGINE_API_ROUTES)[EngineApiRouteId];

export const ENGINE_API_ROUTE_LIST: readonly RouteDefinition[] = Object.values(ENGINE_API_ROUTES);

/** Problems any route may return, besides its own `problems`. */
export function commonProblems(route: RouteDefinition): readonly ProblemCode[] {
    const problems: ProblemCode[] = ['unauthenticated', 'rate-limited', 'internal-error', 'unavailable'];
    if (route.permission !== null) problems.push('forbidden');
    if (route.stepUp) problems.push('step-up-required');
    if (route.params || route.query || route.body) problems.push('validation-failed');
    if (route.query?.shape['cursor']) problems.push('invalid-cursor');
    if (route.params || route.draft) problems.push('not-found');
    return problems;
}
