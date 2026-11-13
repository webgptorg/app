/**
 * The engine's agents by name, one page: the query Home's avatars and the agent filters share, so Home adds no request
 * of its own. A module of its own, so the route loader can prefetch it without loading the colour code.
 */
export const AGENT_LOOK_PARAMS = { limit: 100, sort: 'name' } as const;
