import type { UiLoaderCheck } from '../../../src/index';
import { Bench, UI_LOADER_CHECKS, UI_LOADER_SUITE_ID } from '../../../src/index';
import type { PlatformCheck, PlatformSuite } from '../../harness/platform';
import { startTunnelRelay } from '../../tunnel/tunnel-relay';
import type { EngineEndpoints } from './endpoints';
import type { RegisterEngine } from './platform-lab';
import { openPlatformLab } from './platform-lab';

/**
 * Per check: about three times the slowest check against the mock engine (`provenance.exact-identity`, 7 s for some
 * 15 restarts). An engine that takes longer to restart and re-dial its relay needs a longer `--timeout-ms`.
 */
export const UI_LOADER_CHECK_TIMEOUT_MS = 20_000;

export interface UiLoaderPlatformSuiteOptions {
    /** How the engine API is reached; `null` skips every check with `engine-api-unreachable`. */
    readonly endpoints: EngineEndpoints | null;
    readonly register?: RegisterEngine;
}

function toPlatformCheck(check: UiLoaderCheck, options: UiLoaderPlatformSuiteOptions): PlatformCheck {
    return {
        id: check.id,
        suite: UI_LOADER_SUITE_ID,
        title: check.title,
        timeoutMs: () => UI_LOADER_CHECK_TIMEOUT_MS,
        async run(ctx) {
            if (options.endpoints === null) return { kind: 'skip', reason: 'engine-api-unreachable' };
            const lab = await openPlatformLab(ctx, {
                endpoints: options.endpoints,
                ...(options.register === undefined ? {} : { register: options.register }),
            });
            try {
                return await check.run(await Bench.open(lab), ctx);
            } finally {
                await lab.close();
            }
        },
    };
}

/**
 * The engine's UI loader, black-box: each check gets its own registered engine, fake release store and relay,
 * restarts the engine with the update settings it needs and reads what the engine serves and reports.
 */
export function createUiLoaderPlatformSuite(options: UiLoaderPlatformSuiteOptions): PlatformSuite {
    return { id: UI_LOADER_SUITE_ID, checks: UI_LOADER_CHECKS.map((check) => toPlatformCheck(check, options)) };
}

/** The engine API through C-09's fake relay; one relay is enough, since no ui-loader check is about failover. */
export const TUNNEL_RELAY_ENDPOINTS: EngineEndpoints = { prepare: (ctx) => startTunnelRelay(ctx, { relays: 1 }) };

export const UI_LOADER_PLATFORM_SUITE: PlatformSuite = createUiLoaderPlatformSuite({
    endpoints: TUNNEL_RELAY_ENDPOINTS,
});

export type { EngineEndpoints, EngineRoute } from './endpoints';
