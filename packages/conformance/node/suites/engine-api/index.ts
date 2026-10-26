import type { CheckContext, ConformanceCheck, ConformanceSuite, ConformanceTarget } from '../../../src/index';
import { ENGINE_API_SUITE } from '../../../src/index';
import { startRegisteredEngine } from '../../fakes/dashboard';
import type { PlatformCheck, PlatformCheckContext, PlatformSuite } from '../../harness/platform';
import { startTunnelRelay } from '../../tunnel/tunnel-relay';

export interface EngineApiPlatformSuiteOptions {
    /** `false` when the engine runs its API without the gateway in front of it; the gateway checks then skip. */
    readonly gateway?: boolean;
    /** The portable suite to run; the package's own unless a test narrows it. */
    readonly suite?: ConformanceSuite;
}

/**
 * One registered engine behind a fake relay for the whole suite: its checks create and delete their own resources,
 * so they need no fresh engine each, and starting one per check would multiply the run's length. Without a session
 * factory the target has no sessions, and the checks that need one skip as they do against `--base-url`.
 */
async function openEngine(ctx: PlatformCheckContext, gateway: boolean | undefined): Promise<ConformanceTarget> {
    const relay = await startTunnelRelay(ctx, { relays: 1 });
    const registered = await startRegisteredEngine(ctx, { env: relay.env });
    const endpoint = await relay.endpointFor(registered);
    const target = ctx.engineTarget(registered.engine, endpoint) ?? {
        ...endpoint,
        session: () => Promise.resolve(null),
    };
    return {
        ...target,
        enginePublicKey: registered.identity.enginePublicKey,
        ...(gateway === false ? { gateway: false } : {}),
    };
}

function checkContext(ctx: PlatformCheckContext, target: ConformanceTarget): CheckContext {
    return { random: ctx.random, signal: ctx.signal, resources: ctx.resources, runId: ctx.runId, target };
}

/** The `engine-api` suite (C-05), unchanged, against an engine the harness starts and reaches through its relay. */
export function createEngineApiPlatformSuite(options: EngineApiPlatformSuiteOptions = {}): PlatformSuite {
    const suite = options.suite ?? ENGINE_API_SUITE;
    const target = (ctx: PlatformCheckContext) =>
        ctx.suiteFixture(suite.id, (scope) => openEngine(scope, options.gateway));
    const toPlatformCheck = (check: ConformanceCheck): PlatformCheck => ({
        id: check.id,
        suite: check.suite,
        title: check.title,
        async run(ctx) {
            return check.run(checkContext(ctx, await target(ctx)));
        },
    });
    const describe = suite.engineVersion?.bind(suite);
    return {
        id: suite.id,
        checks: suite.checks.map(toPlatformCheck),
        ...(describe === undefined
            ? {}
            : { engineVersion: async (ctx: PlatformCheckContext) => describe(checkContext(ctx, await target(ctx))) }),
    };
}

export const ENGINE_API_PLATFORM_SUITE: PlatformSuite = createEngineApiPlatformSuite();
