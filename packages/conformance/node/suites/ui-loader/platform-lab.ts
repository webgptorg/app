import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EngineSettings, UiLoaderLab, UpdatePolicySetting } from '../../../src/index';
import { skip } from '../../../src/index';
import type { RegisteredEngine, RegisteredEngineOptions } from '../../fakes/dashboard';
import { startRegisteredEngine } from '../../fakes/dashboard';
import { LOOPBACK_DOMAIN } from '../../harness/loopback';
import type { PlatformCheckContext } from '../../harness/platform';
import type { EngineRoute } from './endpoints';
import type { StoreServer } from './store-server';
import { openStoreServer } from './store-server';

export const UI_STORE_HOSTNAME = `ui-store.${LOOPBACK_DOMAIN}`;
const LOG_TAIL_LINES = 40;

/** How the lab gets a registered engine; the harness's fake dashboard unless a test replaces it. */
export type RegisterEngine = (ctx: PlatformCheckContext, options: RegisteredEngineOptions) => Promise<RegisteredEngine>;

export interface PlatformLabOptions {
    readonly route: EngineRoute;
    readonly register?: RegisterEngine;
}

/** The update settings as a restart patch: `null` removes `PTBK_PINNED_VERSION` when the policy is not `pinned`. */
function updatePatch(update: UpdatePolicySetting): Record<string, string | null> {
    return {
        PTBK_UPDATE_POLICY: update.policy,
        PTBK_PINNED_VERSION: update.policy === 'pinned' ? update.version : null,
    };
}

function withoutRemovals(patch: Readonly<Record<string, string | null>>): Record<string, string> {
    return Object.fromEntries(Object.entries(patch).filter((entry): entry is [string, string] => entry[1] !== null));
}

/**
 * The `ui-loader` lab on the platform harness, for one check: a fake release store over HTTPS on loopback (its
 * certificate from the run's CA, which the engine trusts through `NODE_EXTRA_CA_CERTS`), and a registered engine
 * reached through `route`. The first start registers the engine; later ones restart it in the same data directory,
 * and `fresh` registers a new engine on a new one, so every piece of loader state starts empty.
 */
export async function openPlatformLab(ctx: PlatformCheckContext, options: PlatformLabOptions): Promise<UiLoaderLab> {
    const register = options.register ?? startRegisteredEngine;
    const store: StoreServer = ctx.use(
        await openStoreServer({ hostname: UI_STORE_HOSTNAME, ...ctx.ca.issue([UI_STORE_HOSTNAME]) }),
    );
    const trustFile = join(await ctx.tempDir('ui-loader'), 'conformance-trust.json');
    let current: RegisteredEngine | null = null;

    return {
        store,
        async start(settings: EngineSettings, { fresh, signal }) {
            signal.throwIfAborted();
            // Created 0600, and kept so if it already existed: the file decides which code the engine accepts.
            await writeFile(trustFile, JSON.stringify(settings.trust), { mode: 0o600 });
            await chmod(trustFile, 0o600);
            const patch = {
                PTBK_UI_RELEASE_URL: store.url.href,
                PTBK_CONFORMANCE_TRUST_FILE: trustFile,
                ...updatePatch(settings.update),
            };
            if (current === null || fresh) {
                await current?.engine.stop();
                current = await register(ctx, { env: { ...options.route.env, ...withoutRemovals(patch) } });
            } else {
                await current.restart(patch);
            }
            signal.throwIfAborted();
            const endpoint = await options.route.endpointFor(current);
            const target = ctx.engineTarget(current.engine, endpoint);
            if (target === null) skip('engine-api-unreachable');
            return target;
        },
        logTail: () => current?.engine.logs().split('\n').slice(-LOG_TAIL_LINES).join('\n') ?? '',
        async close() {
            await current?.engine.stop();
        },
    };
}
