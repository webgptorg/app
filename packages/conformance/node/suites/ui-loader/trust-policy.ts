import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StagingTrustPolicy } from '@ptbk/protocol';
import { STAGING_MIN_DELAY_MS, StagingTrustPolicy as StagingTrustPolicySchema } from '@ptbk/protocol';

import { Findings, PASS, UI_LOADER_SUITE_ID } from '../../../src/index';
import { createReleaseKeys, trustPolicyOf } from '../../../src/suites/ui-loader/releases';
import { EngineExited, WaitTimeout, startFakeDashboard, startRegisteredEngine } from '../../fakes/dashboard';
import type { PlatformCheck, PlatformCheckContext } from '../../harness/platform';
import { UI_STORE_HOSTNAME } from './platform-lab';
import { openStoreServer } from './store-server';

/** The variable a release build reads its trust policy from (ui-loader.md, "Where the trust policy comes from"). */
export const TRUST_POLICY_FILE_ENV = 'PTBK_UI_TRUST_POLICY_FILE';

/** Five minutes, as the platform's own staging policy sets them: well inside what the staging profile allows. */
const STAGING_DELAY_MS = 5 * STAGING_MIN_DELAY_MS;

async function stagingPolicy(): Promise<StagingTrustPolicy> {
    const keys = await createReleaseKeys();
    return StagingTrustPolicySchema.parse({
        ...trustPolicyOf({ maintainers: keys.maintainers, releasePublicKeys: [keys.release.publicKey()] }),
        profile: 'staging',
        delays: { regularMs: STAGING_DELAY_MS, securityMs: STAGING_DELAY_MS },
    });
}

/**
 * A staging policy in a 0600 file, and an empty release store over HTTPS: everything a release build needs to start
 * its UI loader, so the policy is the only thing it can object to.
 */
async function uiLoaderEnv(ctx: PlatformCheckContext): Promise<{ readonly file: string; readonly releaseUrl: string }> {
    const file = join(await ctx.tempDir('trust-policy'), 'trust-policy.staging.json');
    await writeFile(file, JSON.stringify(await stagingPolicy()), { mode: 0o600 });
    await chmod(file, 0o600);
    const store = ctx.use(await openStoreServer({ hostname: UI_STORE_HOSTNAME, ...ctx.ca.issue([UI_STORE_HOSTNAME]) }));
    return { file, releaseUrl: store.url.href };
}

export const stagingRefusedInProduction: PlatformCheck = {
    id: 'ui-loader.trust-policy.staging-refused-in-production',
    suite: UI_LOADER_SUITE_ID,
    title: `A production build refuses to start with a staging trust policy in ${TRUST_POLICY_FILE_ENV}, naming the file`,
    timeoutMs: (expectations) => expectations.startTimeoutMs * 2,
    async run(ctx) {
        if (!ctx.productionBuild) return { kind: 'skip', reason: 'no-production-build' };
        const { file, releaseUrl } = await uiLoaderEnv(ctx);
        // Linked like any engine, so a build that ignores the policy has every reason to keep running.
        const dashboard = ctx.use(await startFakeDashboard(ctx));
        const engine = await ctx.engine({
            build: 'production',
            env: {
                ...dashboard.env,
                PTBK_LINK_CODE: dashboard.issueLinkCode(),
                PTBK_UI_RELEASE_URL: releaseUrl,
                [TRUST_POLICY_FILE_ENV]: file,
            },
        });
        await engine.start();
        const exit = await engine.waitForExit(ctx.expectations.startTimeoutMs, ctx.signal);
        const findings = new Findings();
        if (exit === null) {
            findings.add(`the engine kept running for ${String(ctx.expectations.startTimeoutMs)} ms`);
        } else if (exit.code === 0 || exit.code === null) {
            findings.add(`the engine exited with ${exit.signal ?? 'status 0'}, not a failure status`);
        }
        if (dashboard.registrations.length > 0 || dashboard.heartbeats.length > 0) {
            findings.add('the engine contacted the dashboard before refusing: the policy is read once, at startup');
        }
        if (!engine.logs().includes(file)) {
            findings.add(`the engine's output does not name the policy file by its path (${file})`);
        }
        return findings.outcome();
    },
};

export const stagingAcceptedOutsideProduction: PlatformCheck = {
    id: 'ui-loader.trust-policy.staging-accepted-outside-production',
    suite: UI_LOADER_SUITE_ID,
    title: `Outside production, the engine starts with the same staging trust policy in ${TRUST_POLICY_FILE_ENV}`,
    timeoutMs: (expectations) => expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs,
    async run(ctx) {
        const { file, releaseUrl } = await uiLoaderEnv(ctx);
        try {
            await startRegisteredEngine(ctx, {
                env: { PTBK_UI_RELEASE_URL: releaseUrl, [TRUST_POLICY_FILE_ENV]: file },
            });
        } catch (error) {
            if (error instanceof EngineExited || error instanceof WaitTimeout) {
                return { kind: 'fail', detail: `with a staging trust policy, ${error.message}` };
            }
            throw error;
        }
        return PASS;
    },
};

/** Where a release build's trust policy comes from: process-level checks, so they need no lab and no engine API. */
export const TRUST_POLICY_CHECKS: readonly PlatformCheck[] = [
    stagingRefusedInProduction,
    stagingAcceptedOutsideProduction,
];
