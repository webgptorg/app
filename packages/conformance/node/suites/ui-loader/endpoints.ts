import type { RegisteredEngine } from '../../fakes/dashboard';
import type { LaunchEnv } from '../../harness/launch-env';
import type { EngineApiEndpoint, PlatformCheckContext } from '../../harness/platform';

/**
 * How a check reaches the engine API of an engine it started: through a relay that routes it (C-09's fake relay).
 * A port, so the suite does not depend on which relay that is; without one the checks that need the API skip.
 */
export interface EngineEndpoints {
    /** Starts the relay for one check and registers it for teardown with `ctx.use()`. */
    prepare(ctx: PlatformCheckContext): Promise<EngineRoute>;
}

export interface EngineRoute {
    /** Merged into the engine's launch environment on its first start, e.g. `PTBK_RELAYS`. */
    readonly env: LaunchEnv;
    /**
     * Resolves once the relay routes this engine. The endpoint stays valid across `restart()`; calling again after a
     * restart resolves once the restarted engine is routed again.
     */
    endpointFor(engine: RegisteredEngine): Promise<EngineApiEndpoint>;
}
