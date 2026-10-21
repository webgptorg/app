import type { EngineHostnameStore } from '../domain/registry/engine-hostname-store';

/** Until D-08 adds `engine_hostnames`, every engine routes on its default hostname only. */
export const noCustomHostnames: EngineHostnameStore = {
    activeCustomHostnames: () => Promise.resolve([]),
};
