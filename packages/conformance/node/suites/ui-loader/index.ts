import type { UiLoaderCheck } from '../../../src/index';
import { Bench, UI_LOADER_CHECKS, UI_LOADER_SUITE_ID } from '../../../src/index';
import type { PlatformCheck, PlatformSuite } from '../../harness/platform';
import type { EngineEndpoints } from './endpoints';
import type { RegisterEngine } from './platform-lab';
import { openPlatformLab } from './platform-lab';

/**
 * Per check. The longest checks restart the engine a few dozen times, each restart waiting for a heartbeat and for
 * the relay to route the engine again.
 */
export const UI_LOADER_CHECK_TIMEOUT_MS = 10 * 60_000;

export interface UiLoaderPlatformSuiteOptions {
    /** How the engine API is reached; `null` skips every check, as C-08's suites do without a relay. */
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
            const route = await options.endpoints.prepare(ctx);
            const lab = await openPlatformLab(ctx, {
                route,
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
 * The engine's UI loader, black-box: each check gets its own registered engine, fake release store and relay route,
 * restarts the engine with the update settings it needs and reads what the engine serves and reports.
 */
export function createUiLoaderPlatformSuite(options: UiLoaderPlatformSuiteOptions): PlatformSuite {
    return { id: UI_LOADER_SUITE_ID, checks: UI_LOADER_CHECKS.map((check) => toPlatformCheck(check, options)) };
}

export const UI_LOADER_PLATFORM_SUITE: PlatformSuite = createUiLoaderPlatformSuite({ endpoints: null });

export type { EngineEndpoints, EngineRoute } from './endpoints';
